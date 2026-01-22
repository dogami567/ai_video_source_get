import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import "dotenv/config";
import dotenv from "dotenv";
import Exa from "exa-js";
import express from "express";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const app = express();
app.use(express.json({ limit: "2mb" }));

type ToolserverArtifact = { id: string; project_id: string; kind: string; path: string; created_at_ms: number };
type ToolserverSettings = { project_id: string; think_enabled: boolean; updated_at_ms: number };
type ToolserverFfmpegPipeline = {
  input_video_artifact_id: string;
  fingerprint: string;
  clips: ToolserverArtifact[];
};
type ToolserverProfile = { profile?: { prompt?: string } };

const repoRoot = path.resolve(process.cwd(), "../..");
const dataDir = path.resolve(repoRoot, process.env.DATA_DIR || "data");

const toolserverPort = Number(process.env.TOOLSERVER_PORT || 6791);
const toolserverBaseUrl = `http://127.0.0.1:${toolserverPort}`;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HttpError(504, `timeout after ${ms}ms`)), ms);
    promise
      .then((v) => resolve(v))
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text) as { error?: string };
      throw new HttpError(res.status, parsed.error || `HTTP ${res.status}`);
    } catch {
      throw new HttpError(res.status, text || `HTTP ${res.status}`);
    }
  }
  return JSON.parse(text) as T;
}

async function toolserverJson<T>(pathName: string, init?: RequestInit): Promise<T> {
  return fetchJson<T>(`${toolserverBaseUrl}${pathName}`, init);
}

async function getThinkEnabled(projectId: string): Promise<boolean> {
  try {
    const s = await toolserverJson<ToolserverSettings>(`/projects/${projectId}/settings`);
    return !!s.think_enabled;
  } catch {
    return true;
  }
}

async function getProfilePrompt(): Promise<string> {
  try {
    const p = await toolserverJson<ToolserverProfile>(`/profile`);
    return String(p?.profile?.prompt || "").trim();
  } catch {
    return "";
  }
}

async function maybeStorePlan(projectId: string, action: string, plan: unknown): Promise<ToolserverArtifact | null> {
  try {
    return await toolserverJson<ToolserverArtifact>(`/projects/${projectId}/artifacts/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "think_plan",
        out_path: `think/${action}-${Date.now()}.json`,
        content: JSON.stringify(plan, null, 2),
      }),
    });
  } catch {
    return null;
  }
}

function extractGeminiText(payload: any): string {
  const candidates = payload?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try ```json ... ```
    const m = trimmed.match(/```json\\s*([\\s\\S]*?)\\s*```/i);
    if (m?.[1]) {
      try {
        return JSON.parse(m[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "orchestrator" });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    default_model: process.env.DEFAULT_MODEL || "gemini-3-pro-preview",
    base_url: process.env.BASE_URL || "",
  });
});

app.post("/api/projects/:projectId/gemini/analyze", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing project id" });

    const thinkEnabled = await getThinkEnabled(projectId);

    const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "GEMINI_API_KEY is not set; set GEMINI_API_KEY (and optionally BASE_URL) in .env and restart",
      });
    }

    const baseUrl = String(process.env.BASE_URL || "").trim() || "https://generativelanguage.googleapis.com";
    const model = String(req.body?.model || process.env.DEFAULT_MODEL || "gemini-3-pro-preview").trim();

    let inputVideoArtifactId = String(req.body?.input_video_artifact_id || "").trim();
    if (!inputVideoArtifactId) {
      const artifacts = await toolserverJson<ToolserverArtifact[]>(`/projects/${projectId}/artifacts`);
      const input = artifacts.find((a) => a.kind === "input_video");
      if (!input) return res.status(400).json({ ok: false, error: "no input_video found; import a local video first" });
      inputVideoArtifactId = input.id;
    }

    const plan = thinkEnabled
      ? {
          action: "gemini_analyze",
          steps: [
            { action: "ffmpeg_pipeline", input_video_artifact_id: inputVideoArtifactId },
            { action: "gemini_generate", model },
            { action: "store_analysis" },
          ],
        }
      : null;
    const planArtifact = plan ? await maybeStorePlan(projectId, "gemini-analyze", plan) : null;

    const pipeline = await toolserverJson<ToolserverFfmpegPipeline>(`/projects/${projectId}/pipeline/ffmpeg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input_video_artifact_id: inputVideoArtifactId }),
    });

    const clips = pipeline.clips.slice(0, 3);
    if (clips.length === 0) return res.status(500).json({ ok: false, error: "ffmpeg pipeline returned no clips" });

    const profilePrompt = await getProfilePrompt();
    const parts: any[] = [
      {
        text: [
          "You are VidUnpack (视频拆解箱).",
          "Analyze the provided video clips (start/mid/end) and infer how this video was made, focusing on meme-story style videos.",
          "Return JSON only (no markdown) with keys:",
          "- summary",
          "- likely_assets (array)",
          "- voice_over (how it was made; platform guesses)",
          "- editing_steps (short steps)",
          "- search_queries (array, for finding assets)",
          "- extra_clips_needed (array of {start_s,duration_s,reason})",
          ...(profilePrompt ? ["", "User profile (cross-project preferences):", profilePrompt] : []),
        ].join("\n"),
      },
    ];

    for (const clip of clips) {
      const abs = path.join(dataDir, clip.path);
      const buf = await readFile(abs);
      parts.push({
        inline_data: { mime_type: "video/mp4", data: buf.toString("base64") },
      });
    }

    const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, baseUrl);
    url.searchParams.set("key", apiKey);

    const geminiPayload = await fetchJson<any>(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
    });

    const text = extractGeminiText(geminiPayload);
    const parsed = tryParseJson(text);

    const outPath = `analysis/gemini-${Date.now()}.json`;
    const artifact = await toolserverJson<ToolserverArtifact>(`/projects/${projectId}/artifacts/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "analysis_gemini",
        out_path: outPath,
        content: JSON.stringify(
          {
            model,
            input_video_artifact_id: inputVideoArtifactId,
            clips,
            gemini: geminiPayload,
            text,
            parsed,
          },
          null,
          2,
        ),
      }),
    });

    return res.json({
      ok: true,
      plan,
      plan_artifact: planArtifact,
      model,
      input_video_artifact_id: inputVideoArtifactId,
      artifact,
      text,
      parsed,
    });
  } catch (e) {
    if (e instanceof HttpError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 500;
      return res.status(status).json({ ok: false, error: e.message });
    }
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post("/api/projects/:projectId/exa/search", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing project id" });

    const thinkEnabled = await getThinkEnabled(projectId);

    const apiKey = String(process.env.EXA_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "EXA_API_KEY is not set; set EXA_API_KEY in .env and restart",
      });
    }

    const query = String(req.body?.query || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "missing query" });

    const artifacts = await toolserverJson<ToolserverArtifact[]>(`/projects/${projectId}/artifacts`);
    const roundsUsed = artifacts.filter((a) => a.kind === "exa_search").length;
    if (roundsUsed >= 3) {
      return res.status(400).json({ ok: false, error: "search rounds budget exceeded (max 3)" });
    }
    const round = roundsUsed + 1;

    const plan = thinkEnabled
      ? {
          action: "exa_search",
          steps: [{ action: "exa.search", query, num_results: 5 }, { action: "store_search_results", round }],
        }
      : null;
    const planArtifact = plan ? await maybeStorePlan(projectId, "exa-search", plan) : null;

    const exa = new Exa(apiKey);
    const raw = await withTimeout(exa.search(query, { numResults: 5 }), 20_000);
    const results = Array.isArray((raw as any)?.results) ? (raw as any).results : [];

    const artifact = await toolserverJson<ToolserverArtifact>(`/projects/${projectId}/artifacts/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "exa_search",
        out_path: `search/exa-round-${round}.json`,
        content: JSON.stringify({ query, round, results }, null, 2),
      }),
    });

    return res.json({ ok: true, plan, plan_artifact: planArtifact, round, query, artifact, results });
  } catch (e) {
    if (e instanceof HttpError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 500;
      return res.status(status).json({ ok: false, error: e.message });
    }
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post("/api/projects/:projectId/exa/fetch", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing project id" });

    const thinkEnabled = await getThinkEnabled(projectId);

    const apiKey = String(process.env.EXA_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "EXA_API_KEY is not set; set EXA_API_KEY in .env and restart",
      });
    }

    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });
    if (!(url.startsWith("http://") || url.startsWith("https://"))) {
      return res.status(400).json({ ok: false, error: "url must start with http:// or https://" });
    }

    const artifacts = await toolserverJson<ToolserverArtifact[]>(`/projects/${projectId}/artifacts`);
    const fetchesUsed = artifacts.filter((a) => a.kind === "web_fetch").length;
    if (fetchesUsed >= 3) {
      return res.status(400).json({ ok: false, error: "web_fetch budget exceeded (max 3)" });
    }
    const nth = fetchesUsed + 1;

    const plan = thinkEnabled
      ? {
          action: "web_fetch",
          steps: [
            { action: "exa.getContents", url, max_characters: 5000 },
            { action: "store_fetch_content", nth },
          ],
        }
      : null;
    const planArtifact = plan ? await maybeStorePlan(projectId, "web-fetch", plan) : null;

    const exa = new Exa(apiKey);
    const raw = await withTimeout(
      exa.getContents([url], {
        text: { maxCharacters: 5000 },
      }),
      20_000,
    );

    const artifact = await toolserverJson<ToolserverArtifact>(`/projects/${projectId}/artifacts/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "web_fetch",
        out_path: `fetch/web-${nth}.json`,
        content: JSON.stringify({ url, nth, raw }, null, 2),
      }),
    });

    return res.json({ ok: true, plan, plan_artifact: planArtifact, url, artifact, raw });
  } catch (e) {
    if (e instanceof HttpError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 500;
      return res.status(status).json({ ok: false, error: e.message });
    }
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ ok: false, error: message });
  }
});

// Production-style routing helpers:
// - Proxy /tool/* to the Rust toolserver (needed for built web bundles)
// - Serve built web UI from apps/web/dist if present
app.use("/tool", async (req, res) => {
  try {
    const targetPath = req.originalUrl.replace(/^\/tool/, "");
    const url = `${toolserverBaseUrl}${targetPath}`;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (key === "host" || key === "connection" || key === "content-length") continue;
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v) && v.length > 0) headers[k] = v.join(", ");
    }

    const method = req.method.toUpperCase();
    let body: any = undefined;
    let duplex: any = undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (req.is("application/json") && req.body != null) {
        body = JSON.stringify(req.body);
      } else {
        body = req;
        duplex = "half";
      }
    }

    const upstream = await fetch(url, { method, headers, body, duplex } as any);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") return;
      res.setHeader(key, value);
    });

    if (upstream.body) {
      Readable.fromWeb(upstream.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(502).json({ ok: false, error: `tool proxy failed: ${message}` });
  }
});

const webDistDir = path.resolve(repoRoot, "apps/web/dist");
const webIndexHtml = path.resolve(webDistDir, "index.html");
if (existsSync(webIndexHtml)) {
  app.use(express.static(webDistDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/tool")) return next();
    return res.sendFile(webIndexHtml);
  });
}

const port = Number(process.env.ORCHESTRATOR_PORT || 6790);
app.listen(port, "127.0.0.1", () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${port}`);
});
