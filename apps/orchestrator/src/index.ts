import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";

import "dotenv/config";
import dotenv from "dotenv";
import express from "express";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const app = express();
app.use(express.json({ limit: "2mb" }));

type ToolserverArtifact = { id: string; project_id: string; kind: string; path: string; created_at_ms: number };
type ToolserverFfmpegPipeline = {
  input_video_artifact_id: string;
  fingerprint: string;
  clips: ToolserverArtifact[];
};

const repoRoot = path.resolve(process.cwd(), "../..");
const dataDir = path.resolve(repoRoot, process.env.DATA_DIR || "data");

const toolserverPort = Number(process.env.TOOLSERVER_PORT || 6791);
const toolserverBaseUrl = `http://127.0.0.1:${toolserverPort}`;

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

    const pipeline = await toolserverJson<ToolserverFfmpegPipeline>(`/projects/${projectId}/pipeline/ffmpeg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input_video_artifact_id: inputVideoArtifactId }),
    });

    const clips = pipeline.clips.slice(0, 3);
    if (clips.length === 0) return res.status(500).json({ ok: false, error: "ffmpeg pipeline returned no clips" });

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

    return res.json({ ok: true, model, input_video_artifact_id: inputVideoArtifactId, artifact, text, parsed });
  } catch (e) {
    if (e instanceof HttpError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 500;
      return res.status(status).json({ ok: false, error: e.message });
    }
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ ok: false, error: message });
  }
});

const port = Number(process.env.ORCHESTRATOR_PORT || 6790);
app.listen(port, "127.0.0.1", () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${port}`);
});
