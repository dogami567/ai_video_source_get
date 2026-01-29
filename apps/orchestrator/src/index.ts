import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import "dotenv/config";
import dotenv from "dotenv";
import Exa from "exa-js";
import express from "express";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const app = express();
app.use(express.json({ limit: "2mb" }));

type ToolserverArtifact = { id: string; project_id: string; kind: string; path: string; created_at_ms: number };
type ToolserverSettings = { project_id: string; think_enabled: boolean; updated_at_ms: number };
type ToolserverConsent = { project_id: string; consented: boolean; auto_confirm: boolean; updated_at_ms: number };
type ToolserverFfmpegPipeline = {
  input_video_artifact_id: string;
  fingerprint: string;
  clips: ToolserverArtifact[];
};
type ToolserverProfile = { profile?: { prompt?: string } };
type ToolserverChatMessage = {
  id: string;
  project_id: string;
  chat_id: string;
  role: string;
  content: string;
  data?: unknown | null;
  created_at_ms: number;
};
type ToolserverRemoteMediaInfoSummary = {
  extractor: string;
  id: string;
  title: string;
  duration_s: number | null;
  webpage_url: string;
  thumbnail?: string | null;
  description?: string | null;
};
type ToolserverImportRemoteMediaResponse = {
  info: ToolserverRemoteMediaInfoSummary;
  info_artifact: ToolserverArtifact;
  input_video?: ToolserverArtifact | null;
};

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

  const tryParse = (s: string): unknown | null => {
    const t = String(s || "").trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  // 1) Direct parse (already valid JSON).
  const direct = tryParse(trimmed);
  if (direct != null) return direct;

  // 2) Fenced blocks: ```json ...```, ``` ...```, or ``` json ...```
  const fence = trimmed.match(/```(?:\s*json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    const parsed = tryParse(fence[1]);
    if (parsed != null) return parsed;
  }

  // 3) Best-effort substring extraction from the first "{" to last "}".
  const i0 = trimmed.indexOf("{");
  const i1 = trimmed.lastIndexOf("}");
  if (i0 >= 0 && i1 > i0) {
    const parsed = tryParse(trimmed.slice(i0, i1 + 1));
    if (parsed != null) return parsed;
  }

  // 4) Arrays too.
  const a0 = trimmed.indexOf("[");
  const a1 = trimmed.lastIndexOf("]");
  if (a0 >= 0 && a1 > a0) {
    const parsed = tryParse(trimmed.slice(a0, a1 + 1));
    if (parsed != null) return parsed;
  }

  return null;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "orchestrator" });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    default_model: process.env.DEFAULT_MODEL || "gemini-3-preview",
    base_url: process.env.BASE_URL || "",
  });
});

app.get("/api/system/browsers", (_req, res) => {
  res.json({ ok: true, browsers: detectInstalledBrowsers() });
});

app.post("/api/system/open-browser", (req, res) => {
  try {
    const browser = str(req.body?.browser);
    const url = str(req.body?.url);
    const r = openUrlInBrowser({ browser, url });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error || "failed to open browser" });
    return res.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ ok: false, error: message });
  }
});

function isPrivateHostname(hostname: string): boolean {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return true;
  if (h === "localhost") return true;
  if (h === "::1") return true;

  // IPv4 private ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const n = m.slice(1).map((s) => Number(s));
    if (n.some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return true;
    const [a, b] = n;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  return false;
}

app.get("/api/proxy/image", async (req, res) => {
  try {
    const urlRaw = str((req.query as any)?.url);
    const refererRaw = str((req.query as any)?.referer);
    if (!urlRaw) return res.status(400).json({ ok: false, error: "missing url" });
    if (!(urlRaw.startsWith("http://") || urlRaw.startsWith("https://"))) {
      return res.status(400).json({ ok: false, error: "url must start with http:// or https://" });
    }

    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid url" });
    }
    if (isPrivateHostname(parsed.hostname)) {
      return res.status(400).json({ ok: false, error: "refusing to proxy private/local addresses" });
    }

    const headers: Record<string, string> = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    };
    if (refererRaw && (refererRaw.startsWith("http://") || refererRaw.startsWith("https://"))) headers.Referer = refererRaw;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const upstream = await fetch(urlRaw, { headers, signal: ctrl.signal });
    clearTimeout(timer);

    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: `image proxy failed: HTTP ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const contentLength = upstream.headers.get("content-length");

    res.status(200);
    res.setHeader("content-type", contentType);
    if (contentLength) res.setHeader("content-length", contentLength);
    res.setHeader("cache-control", "public, max-age=3600");

    if (upstream.body) {
      Readable.fromWeb(upstream.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(502).json({ ok: false, error: `image proxy failed: ${message}` });
  }
});

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function uniqStrings(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const v = String(x || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function escapeDataUrlSvg(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function extractHttpUrls(text: string, max: number): string[] {
  const t = String(text || "");
  if (!t) return [];

  const urls: string[] = [];
  const re = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) && urls.length < max) {
    const raw = String(m[0] || "");
    const cleaned = raw.replace(/[)\],.。！？]+$/g, "");
    if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) urls.push(cleaned);
  }
  return uniqStrings(urls).slice(0, max);
}

function findBrowserExeWindows(browser: string): string | null {
  const b = String(browser || "").trim().toLowerCase();
  if (!b) return null;

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const candidates: string[] = [];
  if (b === "chrome") {
    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
    );
  } else if (b === "edge" || b === "msedge") {
    candidates.push(
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      localAppData ? path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") : "",
    );
  } else if (b === "firefox") {
    candidates.push(
      path.join(programFiles, "Mozilla Firefox", "firefox.exe"),
      path.join(programFilesX86, "Mozilla Firefox", "firefox.exe"),
    );
  } else {
    return null;
  }

  for (const c of candidates) {
    const p = String(c || "").trim();
    if (!p) continue;
    if (existsSync(p)) return p;
  }
  return null;
}

function detectInstalledBrowsers(): string[] {
  if (process.platform !== "win32") return [];
  const out: string[] = [];
  for (const b of ["edge", "chrome", "firefox"]) {
    if (findBrowserExeWindows(b)) out.push(b);
  }
  return out;
}

function openUrlInBrowser(opts: { browser: string; url: string }): { ok: boolean; error?: string } {
  const url = String(opts.url || "").trim();
  if (!(url.startsWith("http://") || url.startsWith("https://"))) {
    return { ok: false, error: "url must start with http:// or https://" };
  }

  const browser = String(opts.browser || "").trim().toLowerCase();
  if (!browser) return { ok: false, error: "missing browser" };

  if (process.platform !== "win32") {
    return { ok: false, error: "open-browser is only implemented on Windows for now" };
  }

  const exe = findBrowserExeWindows(browser);
  if (!exe) return { ok: false, error: `browser not found: ${browser}` };

  const args: string[] = [];
  if (browser === "chrome" || browser === "edge" || browser === "msedge") {
    args.push("--new-window", url);
  } else if (browser === "firefox") {
    args.push("-new-window", url);
  } else {
    args.push(url);
  }

  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { ok: true };
}

type OpenAIChatMessage =
  | { role: "system" | "user" | "assistant" | "tool"; content: string }
  | { role: "system" | "user" | "assistant" | "tool"; content: Array<Record<string, any>> };

function joinUrl(base: string, pathName: string): string {
  const b = String(base || "").trim();
  const p = String(pathName || "");
  if (!b) return p;
  if (!p) return b;
  const bEnds = b.endsWith("/");
  const pStarts = p.startsWith("/");
  if (bEnds && pStarts) return b + p.slice(1);
  if (!bEnds && !pStarts) return `${b}/${p}`;
  return b + p;
}

function isGeminiNativeBaseUrl(baseUrl: string): boolean {
  const b = String(baseUrl || "").trim().toLowerCase();
  if (!b) return true;
  if (!b.includes("generativelanguage.googleapis.com")) return false;
  // Gemini "OpenAI compatibility" lives under /openai. Treat that as non-native.
  if (b.includes("/openai")) return false;
  return true;
}

function chatCompletionsUrl(baseUrl: string): string {
  const b = String(baseUrl || "").trim();
  const lower = b.toLowerCase();
  if (!b) return "/v1/chat/completions";
  if (lower.includes("/chat/completions")) return b;
  if (lower.includes("/openai")) return joinUrl(b, "chat/completions");
  if (lower.match(/\/v1\/?$/)) return joinUrl(b, "chat/completions");
  return joinUrl(b, "/v1/chat/completions");
}

function authBearer(apiKey: string): string {
  const k = String(apiKey || "").trim();
  if (!k) return "";
  if (/^bearer\s+/i.test(k)) return k;
  return `Bearer ${k}`;
}

function toOpenAiRole(role: string): "system" | "user" | "assistant" | "tool" {
  const r = String(role || "").trim();
  if (r === "assistant" || r === "system" || r === "tool") return r;
  return "user";
}

function extractChatCompletionsText(payload: any): string {
  const choices = payload?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const msg = choices[0]?.message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  }
  return "";
}

async function callChatCompletions(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<any> {
  const url = chatCompletionsUrl(opts.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = authBearer(opts.apiKey);
  if (bearer) headers["authorization"] = bearer;
  return fetchJson<any>(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.4,
      max_tokens: typeof opts.maxTokens === "number" ? opts.maxTokens : 1024,
      stream: false,
    }),
  });
}

async function createChatMessage(
  projectId: string,
  chatId: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
  data?: unknown,
): Promise<ToolserverChatMessage> {
  return toolserverJson<ToolserverChatMessage>(`/projects/${projectId}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, content, data: data ?? null }),
  });
}

async function getChatMessages(projectId: string, chatId: string): Promise<ToolserverChatMessage[]> {
  return toolserverJson<ToolserverChatMessage[]>(`/projects/${projectId}/chats/${chatId}/messages`);
}

async function getConsent(projectId: string): Promise<ToolserverConsent | null> {
  try {
    return await toolserverJson<ToolserverConsent>(`/projects/${projectId}/consent`);
  } catch {
    return null;
  }
}

async function resolveRemoteInfo(
  projectId: string,
  url: string,
  cookiesFromBrowser?: string,
): Promise<ToolserverImportRemoteMediaResponse> {
  return toolserverJson<ToolserverImportRemoteMediaResponse>(`/projects/${projectId}/media/remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      download: false,
      cookies_from_browser: cookiesFromBrowser || undefined,
    }),
  });
}

async function downloadRemoteMedia(
  projectId: string,
  url: string,
  cookiesFromBrowser?: string,
): Promise<ToolserverImportRemoteMediaResponse> {
  return toolserverJson<ToolserverImportRemoteMediaResponse>(`/projects/${projectId}/media/remote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      download: true,
      cookies_from_browser: cookiesFromBrowser || undefined,
    }),
  });
}

function wantsVideoAnalysis(text: string): boolean {
  const t = String(text || "");
  return /分析|拆解|创作|制作|怎么做|镜头|剪辑|节奏|结构|脚本|配音|想做(这类|这种|同款|类似)/i.test(t);
}

function formatAnalysisForChat(parsed: unknown, fallbackText: string): string {
  const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
  const toStrList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];

  if (!isObj(parsed)) {
    // Avoid dumping raw JSON back to the user.
    const t = String(fallbackText || "").trim();
    if (!t || t.startsWith("{") || t.startsWith("[") || t.startsWith("```")) {
      return "我已经完成视频切片分析，但模型返回格式不规范（已保存原始结果到项目产物）。你可以在 Workspace → Artifacts 里打开最新的 analysis_gemini 查看。";
    }
    return t;
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const voiceOver = typeof parsed.voice_over === "string" ? parsed.voice_over.trim() : "";
  const editingSteps = toStrList(parsed.editing_steps);
  const likelyAssets = toStrList(parsed.likely_assets);
  const searchQueries = toStrList(parsed.search_queries);
  const extraClips = Array.isArray(parsed.extra_clips_needed) ? parsed.extra_clips_needed : [];

  const lines: string[] = [];
  lines.push("我已对视频做了切片分析（开头/中段/结尾）。");
  if (summary) {
    lines.push("", "【概览】", summary);
  }
  if (editingSteps.length > 0) {
    lines.push("", "【剪辑结构】", ...editingSteps.map((s, i) => `${i + 1}. ${s}`));
  }
  if (likelyAssets.length > 0) {
    lines.push("", "【关键素材/元素】", ...likelyAssets.map((s) => `- ${s}`));
  }
  if (voiceOver) {
    lines.push("", "【配音/字幕】", voiceOver);
  }
  if (searchQueries.length > 0) {
    lines.push("", "【可用于找同类素材的关键词】", ...searchQueries.map((q) => `- ${q}`));
  }
  if (extraClips.length > 0) {
    lines.push("", "【还想补采的片段】", "我建议再补几个更精准的片段（已在分析结果里列出原因）。");
  }
  return lines.join("\n");
}

async function runGeminiVideoAnalysis(opts: {
  projectId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  useGeminiNative: boolean;
  inputVideoArtifactId: string;
}): Promise<{ artifact: ToolserverArtifact; text: string; parsed: unknown | null; clips: ToolserverArtifact[] }> {
  const pipeline = await toolserverJson<ToolserverFfmpegPipeline>(`/projects/${opts.projectId}/pipeline/ffmpeg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input_video_artifact_id: opts.inputVideoArtifactId }),
  });

  const clips = pipeline.clips.slice(0, 3);
  if (clips.length === 0) throw new Error("ffmpeg pipeline returned no clips");

  const profilePrompt = await getProfilePrompt();
  const promptText = [
    "You are VidUnpack (视频拆解箱).",
    "Analyze the provided video clips (start/mid/end) and infer how this video was made.",
    "Return JSON only (no markdown) with keys:",
    "- summary",
    "- likely_assets (array)",
    "- voice_over (how it was made; platform guesses)",
    "- editing_steps (short steps)",
    "- search_queries (array, for finding assets)",
    "- extra_clips_needed (array of {start_s,duration_s,reason})",
    ...(profilePrompt ? ["", "User profile (cross-project preferences):", profilePrompt] : []),
  ].join("\n");

  const parts: any[] = [{ text: promptText }];
  const openAiContent: any[] = [{ type: "text", text: promptText }];

  for (const clip of clips) {
    const abs = path.join(dataDir, clip.path);
    const buf = await readFile(abs);
    const b64 = buf.toString("base64");
    parts.push({ inline_data: { mime_type: "video/mp4", data: b64 } });
    openAiContent.push({ type: "image_url", image_url: { url: `data:video/mp4;base64,${b64}` } });
  }

  let llmPayload: any;
  if (opts.useGeminiNative) {
    const url = new URL(`/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`, opts.baseUrl);
    url.searchParams.set("key", opts.apiKey);
    llmPayload = await fetchJson<any>(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
    });
  } else {
    llmPayload = await callChatCompletions({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: [{ role: "user", content: openAiContent }],
      temperature: 0.2,
      maxTokens: 2048,
    });
  }

  const text = opts.useGeminiNative ? extractGeminiText(llmPayload) : extractChatCompletionsText(llmPayload);
  const parsed = tryParseJson(text);

  const outPath = `analysis/gemini-${Date.now()}.json`;
  const artifact = await toolserverJson<ToolserverArtifact>(`/projects/${opts.projectId}/artifacts/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "analysis_gemini",
      out_path: outPath,
      content: JSON.stringify(
        {
          provider: opts.useGeminiNative ? "gemini_native" : "openai_compat",
          base_url: opts.baseUrl,
          model: opts.model,
          input_video_artifact_id: opts.inputVideoArtifactId,
          clips,
          llm: llmPayload,
          text,
          parsed,
        },
        null,
        2,
      ),
    }),
  });

  return { artifact, text, parsed, clips };
}

type ChatVideoCard = {
  url: string;
  title: string;
  description?: string | null;
  thumbnail?: string | null;
  duration_s?: number | null;
  extractor?: string;
  id?: string;
};

type ChatAgentPlan = {
  reply: string;
  prompt_draft: string | null;
  should_search: boolean;
  search_queries: string[];
};

const ChatTurnStateAnnotation = Annotation.Root({
  projectId: Annotation<string>(),
  chatId: Annotation<string>(),
  userText: Annotation<string>(),
  userMessage: Annotation<ToolserverChatMessage>(),
  directUrls: Annotation<string[]>(),
  recent: Annotation<ToolserverChatMessage[]>(),

  thinkEnabled: Annotation<boolean>(),
  geminiApiKey: Annotation<string>(),
  exaApiKey: Annotation<string>(),
  googleCseApiKey: Annotation<string>(),
  googleCseCx: Annotation<string>(),
  baseUrl: Annotation<string>(),
  model: Annotation<string>(),
  cookiesFromBrowser: Annotation<string>(),
  useGeminiNative: Annotation<boolean>(),

  directResolveCache: Annotation<Record<string, ToolserverImportRemoteMediaResponse>>(),

  plan: Annotation<unknown | null>(),
  planArtifact: Annotation<ToolserverArtifact | null>(),

  llmPayload: Annotation<any>(),
  llmText: Annotation<string>(),
  llmParsed: Annotation<unknown | null>(),

  agentPlan: Annotation<ChatAgentPlan | null>(),
  videos: Annotation<ChatVideoCard[]>(),
  blocks: Annotation<any[]>(),
  needsConsent: Annotation<boolean>(),

  debugArtifact: Annotation<ToolserverArtifact | null>(),
  assistantMessage: Annotation<ToolserverChatMessage | null>(),
});

type ChatTurnGraphState = typeof ChatTurnStateAnnotation.State;

function ensureUserFacingReplyText(text: unknown): string {
  const t = String(text ?? "").trim();
  if (!t) return "我收到你的消息。你想找什么类型的素材（主题/风格/时长/用途）？";
  if (/^[{[]/.test(t)) return "我收到你的消息，但模型返回了结构化数据。你可以再描述下你想要的素材类型，我会继续。";
  return t;
}

function buildAgentPlanFromLlm(text: string, parsed: unknown | null): ChatAgentPlan {
  const parsedObj = parsed && typeof parsed === "object" ? (parsed as any) : null;
  const reply = typeof parsedObj?.reply === "string" ? parsedObj.reply : "";
  const promptDraft = typeof parsedObj?.prompt_draft === "string" ? parsedObj.prompt_draft : null;
  const shouldSearch = !!parsedObj?.should_search;
  const searchQueries = Array.isArray(parsedObj?.search_queries)
    ? parsedObj.search_queries.map((s: any) => String(s)).filter(Boolean)
    : [];

  return {
    reply: ensureUserFacingReplyText(reply || text),
    prompt_draft: promptDraft,
    should_search: shouldSearch,
    search_queries: searchQueries,
  };
}

const GENERIC_SEARCH_TOKENS = new Set(
  [
    "资源",
    "素材",
    "视频",
    "教程",
    "合集",
    "剪辑",
    "配音",
    "文案",
    "模板",
    "bgm",
    "音乐",
    "加速",
    "高清",
    "下载",
    "表情包",
    "动图",
    "gif",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "mp4",
    "素材包",
    "网盘",
    "链接",
    "链接解析",
    "解析",
    "b站",
    "bilibili",
    "site",
  ].map((s) => s.toLowerCase()),
);

function normalizeSearchText(text: string): string {
  return String(text || "")
    .replace(/\uFEFF/g, "")
    .replace(/dorof/gi, "doro");
}

function extractKeywordTokens(text: string): string[] {
  const t = normalizeSearchText(text);
  const out: string[] = [];

  // ASCII-ish tokens (doro, nikke, etc)
  for (const m of t.matchAll(/[A-Za-z0-9]{2,}/g)) {
    out.push(String(m[0]).toLowerCase());
  }

  // CJK tokens (连续汉字)
  for (const m of t.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    out.push(String(m[0]).toLowerCase());
  }

  return uniqStrings(out).filter(Boolean);
}

function focusTokensFromText(text: string): string[] {
  return extractKeywordTokens(text).filter((tok) => !GENERIC_SEARCH_TOKENS.has(tok));
}

function expandFocusTokens(tokens: string[]): string[] {
  const set = new Set(tokens.map((t) => String(t || "").toLowerCase()).filter(Boolean));

  if (set.has("doro")) {
    for (const s of ["dorothy", "桃乐丝", "多萝", "妮姬", "nikke"]) set.add(s.toLowerCase());
  }

  return Array.from(set);
}

function containsAnyToken(haystack: string, tokens: string[]): boolean {
  const h = String(haystack || "").toLowerCase();
  return tokens.some((t) => {
    const tok = String(t || "").toLowerCase();
    return tok && h.includes(tok);
  });
}

function scoreByTokens(haystack: string, primary: string[], fallback: string[]): number {
  const h = String(haystack || "").toLowerCase();
  let score = 0;

  const primarySet = new Set(primary.map((t) => String(t || "").toLowerCase()).filter(Boolean));
  for (const tok of primarySet) {
    if (h.includes(tok)) score += 3;
  }

  const fallbackSet = new Set(fallback.map((t) => String(t || "").toLowerCase()).filter(Boolean));
  for (const tok of fallbackSet) {
    if (primarySet.has(tok)) continue;
    if (h.includes(tok)) score += 1;
  }

  return score;
}

type WebSearchResult = { title: string; url: string; snippet?: string | null };

type WebSearchProvider = "google_cse" | "exa";

async function googleCseSearch(opts: { apiKey: string; cx: string; query: string; numResults: number }): Promise<WebSearchResult[]> {
  const apiKey = str(opts.apiKey);
  const cx = str(opts.cx);
  const query = str(opts.query);
  const numResults = Math.max(1, Math.min(10, Math.floor(opts.numResults || 5)));
  if (!apiKey || !cx || !query) return [];

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(numResults));

  const raw = await fetchJson<any>(url.toString());
  const items = Array.isArray(raw?.items) ? (raw.items as any[]) : [];
  const out: WebSearchResult[] = [];
  for (const it of items) {
    const u = typeof it?.link === "string" ? it.link : "";
    const t = typeof it?.title === "string" ? it.title : "";
    const sn = typeof it?.snippet === "string" ? it.snippet : null;
    if (!u.startsWith("http")) continue;
    out.push({ url: u, title: t.trim() || u, snippet: sn });
  }
  return out;
}

async function exaSearch(opts: { apiKey: string; query: string; numResults: number }): Promise<WebSearchResult[]> {
  const apiKey = str(opts.apiKey);
  const query = str(opts.query);
  const numResults = Math.max(1, Math.min(20, Math.floor(opts.numResults || 6)));
  if (!apiKey || !query) return [];

  const exa = new Exa(apiKey);
  const raw = await withTimeout(exa.search(query, { numResults }), 20_000);
  const results = Array.isArray((raw as any)?.results) ? ((raw as any).results as any[]) : [];
  const out: WebSearchResult[] = [];
  for (const r0 of results) {
    const u = typeof r0?.url === "string" ? r0.url : "";
    const t = typeof r0?.title === "string" ? r0.title : "";
    if (!u.startsWith("http")) continue;
    out.push({ url: u, title: t.trim() || u, snippet: null });
  }
  return out;
}

async function webSearch(opts: {
  query: string;
  numResults: number;
  googleApiKey?: string;
  googleCx?: string;
  exaApiKey?: string;
  prefer?: WebSearchProvider;
}): Promise<{ provider: WebSearchProvider; results: WebSearchResult[] }> {
  const query = str(opts.query);
  const numResults = Math.max(1, Math.min(20, Math.floor(opts.numResults || 8)));
  const hasGoogle = !!str(opts.googleApiKey) && !!str(opts.googleCx);
  const hasExa = !!str(opts.exaApiKey);

  const prefer: WebSearchProvider = opts.prefer || (hasGoogle ? "google_cse" : "exa");
  const order: WebSearchProvider[] =
    prefer === "google_cse" ? ["google_cse", "exa"] : ["exa", "google_cse"];

  for (const provider of order) {
    if (provider === "google_cse") {
      if (!hasGoogle) continue;
      try {
        const results = await withTimeout(
          googleCseSearch({
            apiKey: str(opts.googleApiKey),
            cx: str(opts.googleCx),
            query,
            numResults: Math.min(numResults, 10),
          }),
          20_000,
        );
        if (results.length > 0) return { provider, results };
      } catch {
        // ignore and fallback
      }
      continue;
    }

    // exa
    if (!hasExa) continue;
    try {
      const results = await withTimeout(exaSearch({ apiKey: str(opts.exaApiKey), query, numResults }), 20_000);
      if (results.length > 0) return { provider, results };
    } catch {
      // ignore and fallback
    }
  }

  return { provider: prefer, results: [] };
}

function isLikelyVideoUrl(url: string): boolean {
  const raw = String(url || "").trim();
  const u = raw.toLowerCase();
  if (!u.startsWith("http")) return false;

  // Direct media files.
  if (/\.(mp4|webm|mkv|mov)(\?|#|$)/i.test(raw)) return true;

  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    host = "";
  }

  if (u.includes("bilibili.com/video/")) return true;
  if (host === "b23.tv") return true;

  if (host.endsWith("youtube.com") && u.includes("watch")) return true;
  if (host === "youtu.be") return true;

  if (host.endsWith("tiktok.com")) return true;
  if (host.endsWith("douyin.com")) return true;
  if (host.endsWith("kuaishou.com")) return true;
  if (host.endsWith("vimeo.com")) return true;
  if (host.endsWith("dailymotion.com")) return true;

  if (host.endsWith("twitter.com") || host.endsWith("x.com")) return true;
  if (host.endsWith("instagram.com")) return true;

  return false;
}

async function chatTurnPlanNode(state: ChatTurnGraphState) {
  const { projectId, directUrls, cookiesFromBrowser, recent, thinkEnabled, useGeminiNative, baseUrl, model, geminiApiKey } = state;

  const directResolveCache = { ...(state.directResolveCache || {}) };

  let referenceForPrompt = "";
  if (directUrls.length === 1) {
    const refUrl = directUrls[0];
    const consent = await getConsent(projectId);
    if (consent?.consented) {
      try {
        const r = await withTimeout(resolveRemoteInfo(projectId, refUrl, cookiesFromBrowser), 12_000);
        directResolveCache[refUrl] = r;
        referenceForPrompt = [
          "User provided a reference video URL (treat as primary reference; do NOT guess topic beyond metadata):",
          `- title: ${r.info.title}`,
          `- url: ${r.info.webpage_url || refUrl}`,
          r.info.description ? `- description: ${r.info.description}` : "",
          r.info.duration_s != null ? `- duration_s: ${r.info.duration_s}` : "",
          r.info.extractor ? `- extractor: ${r.info.extractor}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      } catch {
        referenceForPrompt = `User provided a reference URL: ${refUrl} (title/cover may require clicking Resolve/Download or browser cookies). Do NOT guess its topic.`;
      }
    } else {
      referenceForPrompt = `User provided a reference URL: ${refUrl} (cannot fetch metadata before consent). Do NOT guess its topic.`;
    }
  }

  const systemPrompt = [
    "You are VidUnpack Chat (视频拆解箱对话助手).",
    "Goal: chat with the user to clarify their intent, then search for candidate source videos and present them as cards.",
    "Rules:",
    "- Ask 1-3 clarifying questions if needed.",
    "- If user pasted exactly one video URL, treat it as the primary reference. If multiple URLs are present, ask which one should be the primary reference before searching.",
    "- Only set should_search=true when you are confident about the topic keywords. Avoid overly broad queries; ensure each search_query contains the main topic keyword(s) from the user message.",
    "- Prefer 2-3 topic-consistent search_queries (do not mix unrelated intents like BGM/tutorial unless the user explicitly asked).",
    "- Prefer bilibili for Chinese content by default, but if the user asks for external/off-site sources (e.g. YouTube/TikTok), do NOT restrict to bilibili only.",
    "- When ready, output JSON ONLY (no markdown).",
    "- JSON schema:",
    `  { "reply": string, "prompt_draft"?: string, "should_search"?: boolean, "search_queries"?: string[] }`,
    "- Use Chinese in reply when user is Chinese.",
    "- search_queries should be short and actionable; include platform hints if relevant.",
    ...(referenceForPrompt ? ["", referenceForPrompt] : []),
  ].join("\n");

  const contents = [
    { role: "user", parts: [{ text: systemPrompt }] },
    ...recent.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }],
    })),
  ];

  const openAiMessages: OpenAIChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...recent.map((m) => ({
      role: toOpenAiRole(m.role),
      content: m.content || "",
    })),
  ];

  const plan = thinkEnabled
    ? {
        action: "chat_turn_langgraph",
        steps: [
          { action: "langgraph.plan" },
          useGeminiNative ? { action: "gemini.generateContent", model } : { action: "chat.completions", model, base_url: baseUrl },
          { action: "langgraph.do", nodes: ["resolve_direct_urls", "exa_search_and_resolve"] },
          { action: "langgraph.review" },
        ],
      }
    : null;
  const planArtifact = plan ? await maybeStorePlan(projectId, "chat-turn", plan) : null;

  let llmPayload: any;
  if (useGeminiNative) {
    const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, baseUrl);
    url.searchParams.set("key", geminiApiKey);
      llmPayload = await fetchJson<any>(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      });
    } else {
      llmPayload = await callChatCompletions({
        baseUrl,
        apiKey: geminiApiKey,
        model,
        messages: openAiMessages,
        temperature: 0.2,
        maxTokens: 1024,
      });
    }

  const llmText = useGeminiNative ? extractGeminiText(llmPayload) : extractChatCompletionsText(llmPayload);
  const llmParsed = tryParseJson(llmText);

  return {
    directResolveCache,
    plan,
    planArtifact,
    llmPayload,
    llmText,
    llmParsed,
    agentPlan: buildAgentPlanFromLlm(llmText, llmParsed),
  };
}

async function chatTurnDoResolveDirectUrlsNode(state: ChatTurnGraphState) {
  const { projectId, directUrls, cookiesFromBrowser } = state;

  const agentPlan: ChatAgentPlan = state.agentPlan || {
    reply: ensureUserFacingReplyText(""),
    prompt_draft: null,
    should_search: false,
    search_queries: [],
  };

  const blocks: any[] = [];
  if (agentPlan.prompt_draft && agentPlan.prompt_draft.trim()) {
    blocks.push({ type: "prompt", title: "Prompt", text: agentPlan.prompt_draft.trim() });
  }

  const directResolveCache = { ...(state.directResolveCache || {}) };

  let needsConsent = false;
  const videos: ChatVideoCard[] = [];

  if (directUrls.length > 1) {
    agentPlan.should_search = false;
    agentPlan.search_queries = [];
    const list = directUrls.map((u) => `- ${u}`).join("\n");
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n你发了多个链接，请告诉我哪一个是“参考视频”（我会基于它找同类素材）：\n${list}`;
  }

  if (directUrls.length > 0) {
    const consent = await getConsent(projectId);
    if (!consent?.consented) {
      needsConsent = true;
      agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n要解析/搜索外部链接前，请先在本项目完成一次「授权确认」。`;
      for (const u of directUrls) {
        videos.push({ url: u, title: u, description: null, thumbnail: null, duration_s: null, extractor: "unknown", id: "" });
      }
    } else {
      for (const u of directUrls) {
        try {
          const cached = directResolveCache[u];
          const r = cached || (await resolveRemoteInfo(projectId, u, cookiesFromBrowser));
          directResolveCache[u] = r;
          videos.push({
            url: r.info.webpage_url || u,
            title: r.info.title || u,
            description: r.info.description || null,
            thumbnail: r.info.thumbnail || null,
            duration_s: r.info.duration_s ?? null,
            extractor: r.info.extractor,
            id: r.info.id,
          });
        } catch {
          videos.push({ url: u, title: u, description: null, thumbnail: null, duration_s: null, extractor: "unknown", id: "" });
        }
      }
    }
  }

  if (videos.length > 0) {
    blocks.push({ type: "videos", videos });
  }

  return { agentPlan, videos, blocks, needsConsent, directResolveCache };
}

async function chatTurnDoSearchAndResolveNode(state: ChatTurnGraphState) {
  const { projectId, cookiesFromBrowser, exaApiKey, googleCseApiKey, googleCseCx, userText } = state;

  const agentPlan: ChatAgentPlan = state.agentPlan || {
    reply: ensureUserFacingReplyText(""),
    prompt_draft: null,
    should_search: false,
    search_queries: [],
  };

  const blocks: any[] = Array.isArray(state.blocks) ? [...state.blocks] : [];
  const videos: ChatVideoCard[] = Array.isArray(state.videos) ? [...state.videos] : [];
  const directResolveCache = { ...(state.directResolveCache || {}) };

  if (state.needsConsent) return { agentPlan, blocks, videos, directResolveCache };

  const shouldSearch = agentPlan.should_search && agentPlan.search_queries && agentPlan.search_queries.length > 0;
  if (!shouldSearch) return { agentPlan, blocks, videos, directResolveCache };

  const consent = await getConsent(projectId);
  if (!consent?.consented) {
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n要开始联网搜索/解析链接前，请先在本项目完成一次「授权确认」（外部内容提示）。`;
    return { agentPlan, blocks, videos, needsConsent: true, directResolveCache };
  }

  const hasGoogle = !!str(googleCseApiKey) && !!str(googleCseCx);
  const hasExa = !!str(exaApiKey);
  if (!hasGoogle && !hasExa) {
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n联网搜索未配置：请在设置里填 Exa API Key（或 Google CSE API Key + CX），然后再试；也可以直接把候选链接贴给我。`;
    return { agentPlan, blocks, videos, directResolveCache };
  }
  const primaryFocus = expandFocusTokens(focusTokensFromText(userText));
  const fallbackFocus = expandFocusTokens(focusTokensFromText(agentPlan.search_queries.join(" ")));
  const focusForQueryPick = primaryFocus.length > 0 ? primaryFocus : fallbackFocus;

  const rawQueries = agentPlan.search_queries.map((q) => str(q)).filter(Boolean);
  const pickedQueries = rawQueries.filter((q) => containsAnyToken(q, focusForQueryPick));
  const queries = (pickedQueries.length > 0 ? pickedQueries : rawQueries).slice(0, 3);

  type SearchCandidate = { url: string; title: string; score: number };
  const candidateByUrl = new Map<string, SearchCandidate>();

  const hintText = `${userText} ${rawQueries.join(" ")} ${(state.directUrls || []).join(" ")}`.toLowerCase();
  const wantsExternal = /外站|站外|youtube|youtu|tiktok|douyin|instagram|twitter|x\\.com/i.test(hintText);
  const wantsBilibili = /b站|bilibili|b23\\.tv|bilibili\\.com|\\bbv[0-9a-z]{6,}/i.test(hintText);
  const wantsYoutube = /youtube|youtu|油管/i.test(hintText);

  const preferBilibili = wantsBilibili && !wantsExternal;
  const preferYoutube = wantsYoutube || wantsExternal;

  const platformBoost = (url: string): number => {
    const u = String(url || "").toLowerCase();
    const isBili = u.includes("bilibili.com") || u.includes("b23.tv");
    const isYt = u.includes("youtube.com") || u.includes("youtu.be");

    if (preferBilibili) {
      if (isBili) return 2;
      if (isYt) return -1;
      return 0;
    }
    if (preferYoutube) {
      if (isYt) return 2;
      if (isBili) return -1;
      return 0;
    }

    if (isBili || isYt) return 1;
    return 0;
  };

  const mainQuery = str(queries[0]);
  const hasExplicitSiteFilter = /\bsite:/i.test(mainQuery) || /(bilibili\.com|b23\.tv|youtube\.com|youtu\.be)/i.test(mainQuery);
  const canApplySiteLayer = !!mainQuery && !hasExplicitSiteFilter;
  const order: Array<"broad" | "bilibili" | "youtube"> = preferBilibili
    ? ["bilibili", "broad", "youtube"]
    : preferYoutube
      ? ["youtube", "broad", "bilibili"]
      : ["broad", "bilibili", "youtube"];

  const rounds: Array<{ label: string; query: string }> = [];
  const seenRound = new Set<string>();
  const pushRound = (label: string, q: string) => {
    const q0 = str(q);
    if (!q0) return;
    if (seenRound.has(q0)) return;
    seenRound.add(q0);
    rounds.push({ label, query: q0 });
  };

  const queryByKind = {
    broad: mainQuery,
    bilibili: canApplySiteLayer ? `${mainQuery} site:bilibili.com` : "",
    youtube: canApplySiteLayer ? `${mainQuery} site:youtube.com` : "",
  };

  for (const k of order) pushRound(k, queryByKind[k]);
  for (const q of queries.slice(1)) {
    if (rounds.length >= 3) break;
    pushRound("alt", q);
  }

  for (const { query } of rounds.slice(0, 3)) {
    const { results } = await webSearch({
      query,
      numResults: 12,
      googleApiKey: googleCseApiKey,
      googleCx: googleCseCx,
      exaApiKey,
    });
    if (results.length === 0) continue;

    for (const r of results) {
      const u = str(r.url);
      const t = str(r.title) || u;
      if (!isLikelyVideoUrl(u)) continue;

      const hay = `${t} ${u} ${str(r.snippet)}`;
      const score = scoreByTokens(hay, primaryFocus, fallbackFocus) + platformBoost(u);
      if (score <= 0) continue;

      const prev = candidateByUrl.get(u);
      if (!prev || prev.score < score) {
        candidateByUrl.set(u, { url: u, title: t.trim() || u, score });
      }
    }

    // Enough candidates; avoid extra web search calls.
    if (candidateByUrl.size >= 18) break;
  }

  const ranked = Array.from(candidateByUrl.values()).sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, 6);

  const existing = new Set(videos.map((v) => v.url));
  let unresolved = 0;
  for (const cand of selected) {
    if (existing.has(cand.url)) continue;
    existing.add(cand.url);

    const u = cand.url;
    const fallbackTitle = cand.title || u;
    try {
      const r = await withTimeout(resolveRemoteInfo(projectId, u, cookiesFromBrowser), 12_000);
      directResolveCache[u] = r;
      videos.push({
        url: r.info.webpage_url || u,
        title: r.info.title || fallbackTitle,
        description: r.info.description || null,
        thumbnail: r.info.thumbnail || null,
        duration_s: r.info.duration_s ?? null,
        extractor: r.info.extractor,
        id: r.info.id,
      });
    } catch {
      unresolved += 1;
      videos.push({ url: u, title: fallbackTitle, description: null, thumbnail: null, duration_s: null, extractor: "unknown", id: "" });
    }
  }

  if (videos.length === 0) {
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n我搜到了一些结果，但相关度不高，所以先不乱贴链接。你能补充 1 句话吗：你要的是“表情包/图片/GIF 资源包”，还是“相关的视频素材”？也可以直接给一个示例链接/BV 号，我会按它找同类。`;
    return { agentPlan, blocks, videos, directResolveCache };
  }

  if (unresolved > 0) {
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n注：部分链接暂时无法解析封面/标题（可能需要登录态）。可以在卡片上点「解析/下载」重试，或在 Settings 配置 Cookies from browser 后再试。`;
  }

  const hasVideos = blocks.some((b) => b && typeof b === "object" && (b as any).type === "videos");
  if (videos.length > 0 && !hasVideos) blocks.push({ type: "videos", videos });
  if (videos.length > 0 && hasVideos) {
    for (const b of blocks) {
      if (b && typeof b === "object" && (b as any).type === "videos") {
        (b as any).videos = videos;
        break;
      }
    }
  }

  return { agentPlan, blocks, videos, directResolveCache };
}

async function chatTurnReviewNode(state: ChatTurnGraphState) {
  const agentPlan: ChatAgentPlan = state.agentPlan || {
    reply: ensureUserFacingReplyText(""),
    prompt_draft: null,
    should_search: false,
    search_queries: [],
  };
  agentPlan.reply = ensureUserFacingReplyText(agentPlan.reply);

  if (state.directUrls.length === 1) {
    const refUrl = state.directUrls[0];
    const cached = (state.directResolveCache || {})[refUrl];
    const refTitle = cached?.info?.title ? String(cached.info.title).trim() : "";
    const prefix = refTitle ? `收到：你给的参考视频是「${refTitle}」。` : `收到：你给的参考链接是 ${refUrl}。`;
    const hasRef =
      (refTitle && agentPlan.reply.includes(refTitle)) ||
      agentPlan.reply.includes(refUrl) ||
      agentPlan.reply.includes(refUrl.replace(/^https?:\/\//, ""));
    if (!hasRef) {
      agentPlan.reply = `${prefix}\n\n${agentPlan.reply || "我先确认下你的目标，然后帮你找同类素材。"}\n`;
    }
  }

  return { agentPlan };
}

async function chatTurnPersistNode(state: ChatTurnGraphState) {
  const { projectId, baseUrl, model, useGeminiNative, userMessage, llmText, llmParsed, llmPayload } = state;
  const agentPlan: ChatAgentPlan = state.agentPlan || {
    reply: ensureUserFacingReplyText(""),
    prompt_draft: null,
    should_search: false,
    search_queries: [],
  };
  const videos: ChatVideoCard[] = Array.isArray(state.videos) ? state.videos : [];
  const blocks: any[] = Array.isArray(state.blocks) ? state.blocks : [];

  const debugArtifact = await toolserverJson<ToolserverArtifact>(`/projects/${projectId}/artifacts/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "chat_turn",
      out_path: `chat/turn-${Date.now()}.json`,
      content: JSON.stringify(
        {
          provider: useGeminiNative ? "gemini_native" : "openai_compat",
          base_url: baseUrl,
          model,
          user_message_id: userMessage.id,
          assistant_reply: agentPlan.reply,
          prompt_draft: agentPlan.prompt_draft,
          should_search: agentPlan.should_search,
          search_queries: agentPlan.search_queries,
          videos,
          llm: { text: llmText, parsed: llmParsed, payload: llmPayload },
        },
        null,
        2,
      ),
    }),
  });

  const assistantMessage = await createChatMessage(projectId, state.chatId, "assistant", agentPlan.reply || "OK", {
    blocks,
    debug_artifact: debugArtifact,
  });

  return { debugArtifact, assistantMessage };
}

const chatTurnLangGraph = new StateGraph(ChatTurnStateAnnotation)
  .addNode("llm_plan", chatTurnPlanNode)
  .addNode("resolve_direct_urls", chatTurnDoResolveDirectUrlsNode)
  .addNode("exa_search_and_resolve", chatTurnDoSearchAndResolveNode)
  .addNode("review", chatTurnReviewNode)
  .addNode("persist", chatTurnPersistNode)
  .addEdge(START, "llm_plan")
  .addEdge("llm_plan", "resolve_direct_urls")
  .addEdge("resolve_direct_urls", "exa_search_and_resolve")
  .addEdge("exa_search_and_resolve", "review")
  .addEdge("review", "persist")
  .addEdge("persist", END)
  .compile();

app.post("/api/projects/:projectId/chat/turn", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing project id" });

    const chatId = str(req.body?.chat_id);
    if (!chatId) return res.status(400).json({ ok: false, error: "missing chat_id" });

    const userText = String(req.body?.message || "").trimEnd();
    if (!userText.trim()) return res.status(400).json({ ok: false, error: "missing message" });

    const directUrls = extractHttpUrls(userText, 4);
    const wantsAnalysis = wantsVideoAnalysis(userText);

    const attachmentsRaw = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const attachments = attachmentsRaw
      .map((a: any) => ({
        artifact_id: typeof a?.artifact_id === "string" ? a.artifact_id : "",
        file_name: typeof a?.file_name === "string" ? a.file_name : "",
        mime: typeof a?.mime === "string" ? a.mime : "",
        bytes: typeof a?.bytes === "number" ? a.bytes : null,
      }))
      .filter((a: any) => !!a.artifact_id);

    const thinkEnabled = await getThinkEnabled(projectId);

    const geminiApiKey = str(req.body?.gemini_api_key) || str(req.body?.api_key) || str(process.env.GEMINI_API_KEY);
    const exaApiKey = str(req.body?.exa_api_key) || str(req.body?.api_key) || str(process.env.EXA_API_KEY);
    const googleCseApiKey = str(req.body?.google_cse_api_key) || str(process.env.GOOGLE_CSE_API_KEY);
    const googleCseCx = str(req.body?.google_cse_cx) || str(process.env.GOOGLE_CSE_CX);
    const baseUrl = str(req.body?.base_url) || str(process.env.BASE_URL) || "https://generativelanguage.googleapis.com";
    const model =
      str(req.body?.model) ||
      str(req.body?.default_model) ||
      str(process.env.DEFAULT_MODEL) ||
      "gemini-3-preview";
    const cookiesFromBrowser =
      str(req.body?.ytdlp_cookies_from_browser) || str(process.env.YTDLP_COOKIES_FROM_BROWSER) || "";

    const userMessage = await createChatMessage(
      projectId,
      chatId,
      "user",
      userText,
      attachments.length > 0 ? { attachments } : undefined,
    );

    const mock = str(process.env.E2E_MOCK_CHAT || process.env.MOCK_CHAT) === "1";
    if (mock) {
      const thumb = escapeDataUrlSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#F2F2F7"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="20" fill="#1D1D1F">Video</text></svg>`,
      );
      const detectedUrls = extractHttpUrls(userText, 2);
      const url1 = detectedUrls[0] || "https://www.bilibili.com/video/BV1xx411c7mD";
      const url2 = detectedUrls[1] || "https://www.bilibili.com/video/BV1yy411c7mE";
      const videos: ChatVideoCard[] = [
        {
          url: url1,
          title: "Mock: 猫咪搞笑素材合集",
          description: "（E2E mock）用于验证卡片渲染与按钮交互。",
          thumbnail: thumb,
          duration_s: 123,
          extractor: "bilibili",
          id: "BV1xx411c7mD",
        },
        {
          url: url2,
          title: "Mock: 热门剪辑灵感参考",
          description: "（E2E mock）第二条卡片。",
          thumbnail: thumb,
          duration_s: 98,
          extractor: "bilibili",
          id: "BV1yy411c7mE",
        },
      ];

      const assistantMessage = await createChatMessage(projectId, chatId, "assistant", "我先给你两条示例卡片（mock 模式）。", {
        blocks: [{ type: "videos", videos }],
      });
      return res.json({ ok: true, user_message: userMessage, assistant_message: assistantMessage, mock: true });
    }

    const useGeminiNative = isGeminiNativeBaseUrl(baseUrl);

    if (!geminiApiKey) {
      const assistantMessage = await createChatMessage(
        projectId,
        chatId,
        "assistant",
        "API key is not set. Open Settings and set the API Key first, then try again.",
      );
      return res.json({ ok: true, user_message: userMessage, assistant_message: assistantMessage });
    }

    if (wantsAnalysis) {
      // If the user asks to analyze "this video", try to run the local clip pipeline + Gemini analysis.
      // We prefer an already-downloaded/ imported input_video; if none exists, we can download from the first URL (when auto_confirm is enabled).
      let inputVideoArtifactId = "";
      try {
        const artifacts = await toolserverJson<ToolserverArtifact[]>(`/projects/${projectId}/artifacts`);
        const inputs = artifacts
          .filter((a) => a.kind === "input_video")
          .sort((a, b) => (b.created_at_ms || 0) - (a.created_at_ms || 0));
        if (inputs[0]?.id) inputVideoArtifactId = inputs[0].id;
      } catch {
        // ignore
      }

      const blocks: any[] = [];
      let cards: ChatVideoCard[] = [];

      if (!inputVideoArtifactId && directUrls.length > 0) {
        const consent = await getConsent(projectId);
        if (!consent?.consented) {
          const assistantMessage = await createChatMessage(
            projectId,
            chatId,
            "assistant",
            "我可以通过“切片 → Gemini”来分析你发的视频链接，但需要你先完成一次「授权确认」。请先在页面弹窗里确认授权，然后再发一句“开始分析”。",
          );
          return res.json({ ok: true, needs_consent: true, user_message: userMessage, assistant_message: assistantMessage });
        }

        // Best-effort: still render a card for what the user pasted.
        try {
          const r = await resolveRemoteInfo(projectId, directUrls[0], cookiesFromBrowser);
          cards.push({
            url: r.info.webpage_url || directUrls[0],
            title: r.info.title || directUrls[0],
            description: r.info.description || null,
            thumbnail: r.info.thumbnail || null,
            duration_s: r.info.duration_s ?? null,
            extractor: r.info.extractor,
            id: r.info.id,
          });
        } catch {
          // ignore card failure
        }

        if (cards.length > 0) blocks.push({ type: "videos", videos: cards });

        if (consent?.auto_confirm === false) {
          const assistantMessage = await createChatMessage(
            projectId,
            chatId,
            "assistant",
            "我可以做切片分析，但你已关闭“自动确认下载”。请在卡片上点「下载」把视频保存到项目里，然后再发一句“开始分析”。",
            blocks.length > 0 ? { blocks } : undefined,
          );
          return res.json({ ok: true, user_message: userMessage, assistant_message: assistantMessage });
        }

        // Auto-download for analysis (user asked to analyze and auto_confirm is enabled).
        try {
          const dl = await downloadRemoteMedia(projectId, directUrls[0], cookiesFromBrowser);
          if (dl.input_video?.id) inputVideoArtifactId = dl.input_video.id;
          if (cards.length === 0) {
            cards.push({
              url: dl.info.webpage_url || directUrls[0],
              title: dl.info.title || directUrls[0],
              description: dl.info.description || null,
              thumbnail: dl.info.thumbnail || null,
              duration_s: dl.info.duration_s ?? null,
              extractor: dl.info.extractor,
              id: dl.info.id,
            });
            blocks.push({ type: "videos", videos: cards });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const assistantMessage = await createChatMessage(
            projectId,
            chatId,
            "assistant",
            `下载失败：${msg}\n\n你可以先在卡片上点「下载」重试（或在 Settings 配置 Cookies from browser），下载成功后再发一句“开始分析”。`,
            blocks.length > 0 ? { blocks } : undefined,
          );
          return res.json({ ok: true, user_message: userMessage, assistant_message: assistantMessage });
        }
      }

      if (!inputVideoArtifactId) {
        const assistantMessage = await createChatMessage(
          projectId,
          chatId,
          "assistant",
          directUrls.length > 0
            ? "我可以做切片分析，但目前项目里还没有可用的视频文件。请先在卡片上点「下载」（或在 Workspace 上传本地视频），然后再发一句“开始分析”。"
            : "我可以做切片分析，但你还没导入视频。请先上传/下载一个视频到项目里，然后再说“分析这个视频”。",
          blocks.length > 0 ? { blocks } : undefined,
        );
        return res.json({ ok: true, user_message: userMessage, assistant_message: assistantMessage });
      }

      try {
        const analysis = await runGeminiVideoAnalysis({
          projectId,
          apiKey: geminiApiKey,
          baseUrl,
          model,
          useGeminiNative,
          inputVideoArtifactId,
        });

        const reply = formatAnalysisForChat(analysis.parsed, analysis.text);
        const assistantMessage = await createChatMessage(projectId, chatId, "assistant", reply, {
          blocks,
          analysis_artifact: analysis.artifact,
        });

        return res.json({
          ok: true,
          user_message: userMessage,
          assistant_message: assistantMessage,
          analysis_artifact: analysis.artifact,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const assistantMessage = await createChatMessage(
          projectId,
          chatId,
          "assistant",
          `切片分析失败：${msg}\n\n常见原因：未安装 ffmpeg、视频未下载完成、或 Gemini/代理不支持视频输入。你可以先确认 Workspace 里有 input_video，然后在 Workspace → Analysis 手动跑一次。`,
          blocks.length > 0 ? { blocks } : undefined,
        );
        return res.json({ ok: true, user_message: userMessage, assistant_message: assistantMessage });
      }
    }

    const history = await getChatMessages(projectId, chatId);
    const recent = history.slice(Math.max(0, history.length - 12));

    const graphState = await chatTurnLangGraph.invoke({
      projectId,
      chatId,
      userText,
      userMessage,
      directUrls,
      recent,
      thinkEnabled,
      geminiApiKey,
      exaApiKey,
      googleCseApiKey,
      googleCseCx,
      baseUrl,
      model,
      cookiesFromBrowser,
      useGeminiNative,
      directResolveCache: {},
      plan: null,
      planArtifact: null,
      llmPayload: null,
      llmText: "",
      llmParsed: null,
      agentPlan: null,
      videos: [],
      blocks: [],
      needsConsent: false,
      debugArtifact: null,
      assistantMessage: null,
    });

    const assistantMessage = graphState.assistantMessage
      ? graphState.assistantMessage
      : await createChatMessage(projectId, chatId, "assistant", "OK");

    return res.json({
      ok: true,
      needs_consent: graphState.needsConsent,
      plan: graphState.plan,
      plan_artifact: graphState.planArtifact,
      user_message: userMessage,
      assistant_message: assistantMessage,
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

app.post("/api/projects/:projectId/gemini/analyze", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing project id" });

    const thinkEnabled = await getThinkEnabled(projectId);

    const apiKey = str(req.body?.gemini_api_key) || str(req.body?.api_key) || str(process.env.GEMINI_API_KEY);
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "API key is not set; set it in .env or in the UI Settings and retry",
      });
    }

    const baseUrl =
      str(req.body?.base_url) ||
      str(process.env.BASE_URL) ||
      "https://generativelanguage.googleapis.com";
    const model = str(req.body?.model) || str(process.env.DEFAULT_MODEL) || "gemini-3-preview";
    const useGeminiNative = isGeminiNativeBaseUrl(baseUrl);

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
            useGeminiNative ? { action: "gemini.generateContent", model } : { action: "chat.completions", model, base_url: baseUrl },
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
    const promptText = [
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
    ].join("\n");

    const parts: any[] = [{ text: promptText }];
    const openAiContent: any[] = [{ type: "text", text: promptText }];

    for (const clip of clips) {
      const abs = path.join(dataDir, clip.path);
      const buf = await readFile(abs);
      const b64 = buf.toString("base64");
      parts.push({ inline_data: { mime_type: "video/mp4", data: b64 } });
      openAiContent.push({ type: "image_url", image_url: { url: `data:video/mp4;base64,${b64}` } });
    }

    let llmPayload: any;
    if (useGeminiNative) {
      const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, baseUrl);
      url.searchParams.set("key", apiKey);
      llmPayload = await fetchJson<any>(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
        }),
      });
    } else {
      llmPayload = await callChatCompletions({
        baseUrl,
        apiKey,
        model,
        messages: [{ role: "user", content: openAiContent }],
        temperature: 0.2,
        maxTokens: 2048,
      });
    }

    const text = useGeminiNative ? extractGeminiText(llmPayload) : extractChatCompletionsText(llmPayload);
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
            provider: useGeminiNative ? "gemini_native" : "openai_compat",
            base_url: baseUrl,
            model,
            input_video_artifact_id: inputVideoArtifactId,
            clips,
            llm: llmPayload,
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

    const apiKey = str(req.body?.exa_api_key) || str(req.body?.api_key) || str(process.env.EXA_API_KEY);
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "EXA_API_KEY is not set; set it in .env or in the UI Settings and retry",
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

    const apiKey = str(req.body?.exa_api_key) || str(req.body?.api_key) || str(process.env.EXA_API_KEY);
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: "EXA_API_KEY is not set; set it in .env or in the UI Settings and retry",
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
