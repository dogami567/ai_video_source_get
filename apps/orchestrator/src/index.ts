import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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

const CHAT_MAX_SEARCH_PASSES = (() => {
  const raw = Number(process.env.CHAT_MAX_SEARCH_PASSES);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(5, Math.floor(raw)));
})();

const GEMINI_THINKING_BUDGET = (() => {
  const raw = Number(process.env.GEMINI_THINKING_BUDGET);
  if (!Number.isFinite(raw)) return 1024;
  return Math.max(0, Math.min(8192, Math.floor(raw)));
})();

type ChatTurnStageEvent = {
  stage: string;
  detail?: string | null;
  pass?: number | null;
  max_passes?: number | null;
};

const chatTurnStreamCtx = new AsyncLocalStorage<{ emit: (evt: ChatTurnStageEvent) => void }>();

function emitChatStage(evt: ChatTurnStageEvent) {
  const store = chatTurnStreamCtx.getStore();
  if (!store) return;
  try {
    store.emit(evt);
  } catch {
    // ignore
  }
}

type ToolserverArtifact = { id: string; project_id: string; kind: string; path: string; created_at_ms: number };
type ToolserverSettings = { project_id: string; think_enabled: boolean; updated_at_ms: number };
type ToolserverConsent = { project_id: string; consented: boolean; auto_confirm: boolean; updated_at_ms: number };
type ToolserverFfmpegPipeline = {
  input_video_artifact_id: string;
  fingerprint: string;
  clips: ToolserverArtifact[];
};
type ToolserverProfile = { profile?: { prompt?: string } };
type ToolserverProjectFeedbackItem = {
  url: string;
  kind: string;
  rating: number;
  anchor: boolean;
  created_at_ms: number;
  updated_at_ms: number;
};
type ToolserverProjectFeedback = { ok: boolean; project_id: string; items: ToolserverProjectFeedbackItem[] };
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

async function getProjectFeedback(projectId: string): Promise<ToolserverProjectFeedbackItem[]> {
  try {
    const r = await toolserverJson<ToolserverProjectFeedback>(`/projects/${projectId}/feedback`);
    return Array.isArray(r?.items) ? r.items : [];
  } catch {
    return [];
  }
}

function formatProjectFeedbackForPrompt(items: ToolserverProjectFeedbackItem[]): string {
  const liked = items.filter((x) => (x?.rating ?? 0) > 0).map((x) => String(x.url || "").trim()).filter(Boolean);
  const disliked = items.filter((x) => (x?.rating ?? 0) < 0).map((x) => String(x.url || "").trim()).filter(Boolean);
  const anchors = items.filter((x) => !!x?.anchor).map((x) => String(x.url || "").trim()).filter(Boolean);

  const lines: string[] = [];
  if (anchors.length > 0) lines.push(`Anchor examples (more like this): ${anchors.slice(0, 3).join(", ")}`);
  if (liked.length > 0) lines.push(`Liked sources: ${liked.slice(0, 6).join(", ")}`);
  if (disliked.length > 0) lines.push(`Disliked sources: ${disliked.slice(0, 6).join(", ")}`);
  return lines.join("\n");
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

function normalizeUrlForDedup(url: string): string {
  const raw = str(url);
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";

    // Remove common tracking params while keeping meaningful query params.
    for (const k of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "spm_id_from",
      "vd_source",
      "from",
      "share_source",
      "share_medium",
      "share_plat",
      "share_session_id",
    ]) {
      u.searchParams.delete(k);
    }

    let out = u.toString();
    if (out.endsWith("/") && u.pathname !== "/" && !u.search) out = out.slice(0, -1);
    return out;
  } catch {
    return raw.replace(/#.*$/, "");
  }
}

function recentSuggestedUrlKeys(recent: ToolserverChatMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of Array.isArray(recent) ? recent : []) {
    if (!m) continue;
    const role = str((m as any).role);
    if (role && role !== "assistant") continue;

    // Always include plain URLs found in assistant text.
    for (const u of extractHttpUrls(str((m as any).content), 32)) {
      const key = normalizeUrlForDedup(u);
      if (key) out.add(key);
    }

    const dataRaw = (m as any).data;
    let data: any = dataRaw;
    if (typeof dataRaw === "string") {
      try {
        data = JSON.parse(dataRaw);
      } catch {
        data = null;
      }
    }
    const blocks = Array.isArray(data?.blocks) ? (data.blocks as any[]) : [];
    for (const b of blocks) {
      const type = str(b?.type);
      if (type === "links") {
        const links = Array.isArray(b?.links) ? (b.links as any[]) : [];
        for (const l of links) {
          const key = normalizeUrlForDedup(str(l?.url));
          if (key) out.add(key);
        }
      }
      if (type === "videos") {
        const vids = Array.isArray(b?.videos) ? (b.videos as any[]) : [];
        for (const v of vids) {
          const key = normalizeUrlForDedup(str(v?.url));
          if (key) out.add(key);
        }
      }
    }
  }
  return out;
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

type OpenAIChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, any>>;
  tool_call_id?: string;
  name?: string;
  tool_calls?: OpenAIChatToolCall[];
};

type OpenAIToolDef = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: any;
  };
};

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

function extractChatCompletionsToolCalls(payload: any): OpenAIChatToolCall[] {
  const choices = payload?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const msg = choices[0]?.message;
  const calls = msg?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const out: OpenAIChatToolCall[] = [];
  for (const c of calls) {
    const id = typeof c?.id === "string" ? c.id : "";
    const name = typeof c?.function?.name === "string" ? c.function.name : "";
    const args = typeof c?.function?.arguments === "string" ? c.function.arguments : "";
    if (!id || !name) continue;
    out.push({ id, type: "function", function: { name, arguments: args } });
  }
  return out;
}

function tryParseJsonObject(text: string): any | null {
  const parsed = tryParseJson(text);
  return parsed && typeof parsed === "object" ? (parsed as any) : null;
}

async function callChatCompletions(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: OpenAIToolDef[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
}): Promise<any> {
  const url = chatCompletionsUrl(opts.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = authBearer(opts.apiKey);
  if (bearer) headers["authorization"] = bearer;
  const tools = Array.isArray(opts.tools) ? opts.tools : undefined;
  const toolChoice = opts.toolChoice ?? (tools && tools.length > 0 ? "auto" : undefined);
  return fetchJson<any>(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.4,
      max_tokens: typeof opts.maxTokens === "number" ? opts.maxTokens : 1024,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
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

  const hasUrl = /https?:\/\/\S+/i.test(t);
  const hasVideoContext = /(视频|这条|该视频|这个视频|链接|url)/i.test(t) || hasUrl;

  // If the user is asking for websites / emoji packs / BGM / voiceover resources, do NOT
  // auto-trigger video clip analysis unless they explicitly ask to analyze a video.
  const hasExplicitAnalyzePhrase =
    /(开始分析|切片分析|分析一下|分析下|拆解一下|拆解下|分析这个|拆解这个|analyze|analysis)/i.test(t) ||
    ((/分析|拆解|切片/i.test(t) && hasVideoContext));
  if (!hasExplicitAnalyzePhrase) {
    const intent = detectChatSearchIntent(t);
    if (intent !== "video") return false;
  }

  // Strong triggers
  if (/(开始分析|切片分析|分析一下|分析下|拆解一下|拆解下)/i.test(t)) return true;
  if (/(分析|拆解|切片)/i.test(t) && hasVideoContext) return true;

  // Editing/creation keywords should only trigger when the user is referring to a video.
  if (/(创作|制作|怎么做|镜头|剪辑|节奏|结构|脚本|想做(这类|这种|同款|类似))/i.test(t)) {
    return hasVideoContext;
  }

  return false;
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
  match_tags?: string[] | null;
  match_reason?: string | null;
  match_score?: number | null;
};

type ChatLinkCard = {
  url: string;
  title: string;
  snippet?: string | null;
  match_tags?: string[] | null;
  match_reason?: string | null;
  match_score?: number | null;
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

  // Bounded plan→do→review loop (search may run multiple passes per turn).
  searchPass: Annotation<number>(),
  searchAgain: Annotation<boolean>(),
  reviewPayload: Annotation<any>(),
  reviewText: Annotation<string>(),
  reviewParsed: Annotation<unknown | null>(),

  agentPlan: Annotation<ChatAgentPlan | null>(),
  videos: Annotation<ChatVideoCard[]>(),
  blocks: Annotation<any[]>(),
  needsConsent: Annotation<boolean>(),

  debugArtifact: Annotation<ToolserverArtifact | null>(),
  assistantMessage: Annotation<ToolserverChatMessage | null>(),
});

type ChatTurnGraphState = typeof ChatTurnStateAnnotation.State;

type AgentCandidateKind = "video" | "link";
type AgentCandidate = {
  id: string;
  kind: AgentCandidateKind;
  url: string;
  title: string;
  snippet?: string | null;
  thumbnail?: string | null;
  description?: string | null;
  duration_s?: number | null;
  extractor?: string | null;
  external_license?: string | null;
};

type ChatToolAgentFinal = {
  reply: string;
  select?: { videos?: string[]; links?: string[] } | null;
  scorecard?:
    | Record<
        string,
        {
          score?: number | null;
          tags?: string[] | null;
          reason?: string | null;
        }
      >
    | null;
  dedupe_groups?: string[][] | null;
  notes?: string | null;
};

type ChatToolAgentThinkPlan = {
  intent?: "video" | "audio" | "image" | "web";
  platform_preference?: "bilibili" | "web" | "mixed";
  assumptions?: string[];
  tool_strategy?: string[];
  search_queries?: string[];
  stop_criteria?: string[];
};

const TOOL_AGENT_MAX_PASSES = 5;

const ChatToolAgentStateAnnotation = Annotation.Root({
  projectId: Annotation<string>(),
  chatId: Annotation<string>(),
  userText: Annotation<string>(),
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
  needsConsent: Annotation<boolean>(),

  // OpenAI-style conversation used for tool calling.
  messages: Annotation<OpenAIChatMessage[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  pendingToolCalls: Annotation<OpenAIChatToolCall[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  iterations: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),
  pass: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),

  thinkPayload: Annotation<any>(),
  thinkText: Annotation<string>(),
  thinkParsed: Annotation<unknown | null>(),
  thinkPlan: Annotation<ChatToolAgentThinkPlan | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),

  candidates: Annotation<AgentCandidate[]>({
    reducer: (a, b) => {
      const byId = new Map<string, AgentCandidate>();
      for (const it of a) if (it && it.id) byId.set(it.id, it);
      for (const it of b) if (it && it.id) byId.set(it.id, it);
      return Array.from(byId.values());
    },
    default: () => [],
  }),
  final: Annotation<ChatToolAgentFinal | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  blocks: Annotation<any[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
});

type ChatToolAgentGraphState = typeof ChatToolAgentStateAnnotation.State;

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

function heuristicChatPlan(userText: string): ChatAgentPlan {
  const t = String(userText || "").trim();
  const up = (() => {
    const m = t.match(/up主[“"']([^”"']+)[”"']/i);
    return m?.[1] ? String(m[1]).trim() : "";
  })();

  const tokens = expandFocusTokens(focusTokensFromText(t)).slice(0, 6);
  const base = up || tokens.join(" ");

  const queries: string[] = [];
  const push = (q: string) => {
    const s = String(q || "").trim();
    if (!s) return;
    if (queries.includes(s)) return;
    queries.push(s);
  };

  push(base || t);
  if (/哈基米/i.test(t) && /配音|ai配音|旁白|声音|TTS/i.test(t)) push(`${up || ""} 哈基米 配音 免费 教程`.trim());
  if (/bgm|配乐|音乐/i.test(t)) push(`哈基米 BGM 纯音乐`.trim());
  if (/五分钟|5\s*分钟|大概五分钟|5min/i.test(t) || /画面素材|b-roll|素材/i.test(t)) push(`5分钟 画面素材 B-roll 4K`.trim());

  return {
    reply: ensureUserFacingReplyText(""),
    prompt_draft: null,
    should_search: queries.length > 0,
    search_queries: queries.slice(0, 3),
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

function sha1Hex(text: string): string {
  try {
    return createHash("sha1").update(String(text || ""), "utf8").digest("hex");
  } catch {
    return String(text || "");
  }
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
    const raw = String(m[0]).toLowerCase();
    out.push(raw);
    // Add short n-grams to avoid "b站哈基米" being captured as a single long token ("站哈基米").
    // This improves intent/topic matching without requiring a full tokenizer.
    if (raw.length >= 3 && raw.length <= 12) {
      for (let n = 2; n <= 4; n++) {
        if (raw.length < n) continue;
        for (let i = 0; i + n <= raw.length; i++) {
          out.push(raw.slice(i, i + n));
          if (out.length > 80) break;
        }
        if (out.length > 80) break;
      }
    }
    if (out.length > 120) break;
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

type ChatSearchIntent = "video" | "web" | "image" | "audio";

function detectChatSearchIntent(text: string): ChatSearchIntent {
  const t = String(text || "");
  // Disambiguation: if user explicitly says "视频"/BV/bilibili video links, treat as video unless they explicitly want audio-only.
  // This keeps the agent flexible while respecting strong user signals.
  const wantsVideo =
    /视频|番剧|影视|\bbv[0-9a-z]{6,}\b/i.test(t) || /bilibili\.com\/video\/|b23\.tv\//i.test(t);
  const audioOnly = /不要视频|不需要视频|只要音频|仅音频|只要声音|只要配音|只要bgm/i.test(t);
  if (wantsVideo && !audioOnly) return "video";

  if (/bgm|配音|音效|旁白|声音|音乐|伴奏|sfx|sound effect|voiceover|voice over/i.test(t)) return "audio";
  if (/表情包|emoji|贴纸|gif|png|透明底|图片|素材图|贴图|icon/i.test(t)) return "image";
  if (/网站|网页|站点|信息|资料|教程|仓库|repo|github|开源|document|docs/i.test(t)) return "web";
  return "video";
}

type ChatConstraintHints = {
  wants_license: boolean;
  license_terms: string[];
  target_platforms: string[];
  wants_external: boolean;
  wants_bilibili: boolean;
};

function inferConstraintHints(text: string): ChatConstraintHints {
  const t = String(text || "").toLowerCase();
  const licenseTerms: string[] = [];
  const push = (s: string) => {
    const v = String(s || "").trim();
    if (!v) return;
    if (!licenseTerms.includes(v)) licenseTerms.push(v);
  };
  if (/免版权|无版权|版权无|royalty[- ]?free|copyright[- ]?free/i.test(t)) push("免版权/royalty-free");
  if (/可商用|商用|commercial use|for commercial use/i.test(t)) push("可商用");
  if (/cc0|creative commons 0/i.test(t)) push("CC0");
  if (/署名|attribution|by[- ]?sa|cc-by/i.test(t)) push("需署名/CC-BY");
  if (/不可商用|non[- ]?commercial|cc-nc/i.test(t)) push("不可商用/NC");

  const targetPlatforms: string[] = [];
  if (/b站|bilibili|b23\.tv/i.test(t)) targetPlatforms.push("bilibili");
  if (/youtube|youtu/i.test(t)) targetPlatforms.push("youtube");
  if (/tiktok|douyin|抖音/i.test(t)) targetPlatforms.push("tiktok/douyin");
  if (/instagram|ins\b/i.test(t)) targetPlatforms.push("instagram");

  const wantsExternal = /外站|站外|海外|youtube|youtu|tiktok|douyin|instagram|twitter|x\.com/i.test(t);
  const wantsBilibili = /b站|bilibili|b23\.tv|bilibili\.com|\bbv[0-9a-z]{6,}/i.test(t);

  return {
    wants_license: licenseTerms.length > 0,
    license_terms: licenseTerms,
    target_platforms: targetPlatforms,
    wants_external: wantsExternal,
    wants_bilibili: wantsBilibili,
  };
}

type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string | null;
  thumbnail?: string | null;
  duration_s?: number | null;
};

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

function stripHtmlTags(s: string): string {
  const t = String(s || "");
  return t
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHmsToSeconds(s: string): number | null {
  const raw = String(s || "").trim();
  if (!raw) return null;
  const parts = raw.split(":").map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function sanitizeBilibiliKeyword(query: string): string {
  const q = String(query || "");
  return q
    .replace(/\bsite:[^\s]+/gi, " ")
    .replace(/\binurl:[^\s]+/gi, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function bilibiliSearchVideos(opts: { keyword: string; numResults: number }): Promise<WebSearchResult[]> {
  const keyword = sanitizeBilibiliKeyword(opts.keyword);
  if (!keyword) return [];

  const pageSize = Math.max(1, Math.min(20, Math.floor(opts.numResults || 10)));
  const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
  url.searchParams.set("search_type", "video");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", String(pageSize));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      referer: "https://www.bilibili.com/",
      accept: "application/json, text/plain, */*",
    },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const hint = res.status === 412 ? " (blocked by bilibili risk control; try Exa/Google search or paste a BV/link)" : "";
    throw new Error(`bilibili search failed: HTTP ${res.status}${hint}`);
  }
  const raw = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const code = typeof raw?.code === "number" ? raw.code : null;
  if (code !== null && code !== 0) {
    const msg = typeof raw?.message === "string" ? raw.message : "unknown";
    const hint = code === -412 ? " (blocked by bilibili risk control; try Exa/Google search or paste a BV/link)" : "";
    throw new Error(`bilibili search failed: code=${code} msg=${msg}${hint}`);
  }

  const items: any[] = Array.isArray(raw?.data?.result) ? raw.data.result : [];
  const out: WebSearchResult[] = [];
  for (const it of items) {
    const bvid = str(it?.bvid);
    const title = stripHtmlTags(str(it?.title)) || keyword;
    const desc = stripHtmlTags(str(it?.description)) || null;
    const picRaw = str(it?.pic);
    const pic = picRaw ? (picRaw.startsWith("//") ? `https:${picRaw}` : picRaw) : "";
    const durationS = parseHmsToSeconds(str(it?.duration));
    const u = bvid ? `https://www.bilibili.com/video/${bvid}` : str(it?.arcurl) || "";
    if (!u.startsWith("http")) continue;
    out.push({ url: u, title, snippet: desc, thumbnail: pic || null, duration_s: durationS });
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

  emitChatStage({ stage: "planning" });

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
    "Goal: chat with the user to clarify their intent, then search for candidate sources and present them as cards (videos, emoji/image packs, audio/BGM/voiceover sources, websites).",
    "Rules:",
    "- Ask 1-3 clarifying questions if needed.",
    "- If user pasted exactly one video URL, treat it as the primary reference. If multiple URLs are present, ask which one should be the primary reference before searching.",
    "- Only set should_search=true when you are confident about the topic keywords. Avoid overly broad queries; ensure each search_query contains the main topic keyword(s) from the user message.",
    "- Prefer 2-3 topic-consistent search_queries (do not mix unrelated intents like BGM/tutorial unless the user explicitly asked).",
    "- Prefer bilibili for Chinese content by default, but if the user asks for external/off-site sources (e.g. YouTube/TikTok), do NOT restrict to bilibili only.",
    "- If the user asks for websites/info/images/audio (not videos), focus the queries on that asset type (e.g. emoji pack/png/gif, bgm/sfx/voiceover, resource websites) and do NOT force video platforms.",
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
          { action: "langgraph.do", nodes: ["resolve_direct_urls"] },
          { action: "langgraph.loop", nodes: ["exa_search_and_resolve", "review_refine"], max_passes: CHAT_MAX_SEARCH_PASSES },
          { action: "langgraph.review" },
        ],
      }
    : null;
  const planArtifact = plan ? await maybeStorePlan(projectId, "chat-turn", plan) : null;

  let llmPayload: any;
  let llmText = "";
  let llmParsed: unknown | null = null;
  let agentPlan: ChatAgentPlan | null = null;

  try {
    if (useGeminiNative) {
      const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, baseUrl);
      url.searchParams.set("key", geminiApiKey);
      llmPayload = await fetchJson<any>(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
            ...(thinkEnabled && GEMINI_THINKING_BUDGET > 0 ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } } : {}),
          },
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

    llmText = useGeminiNative ? extractGeminiText(llmPayload) : extractChatCompletionsText(llmPayload);
    llmParsed = tryParseJson(llmText);
    agentPlan = buildAgentPlanFromLlm(llmText, llmParsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Fallback: still attempt a useful search plan without model output.
    agentPlan = heuristicChatPlan(state.userText || "");
    agentPlan.reply =
      "（模型调用失败，已切换为快速检索模式）" +
      (msg ? `\n原因：${String(msg).slice(0, 160)}` : "") +
      "\n我会先在 B 站做检索并给出候选卡片。";
    llmPayload = { ok: false, error: msg };
    llmText = "";
    llmParsed = null;
  }

  return {
    directResolveCache,
    plan,
    planArtifact,
    llmPayload,
    llmText,
    llmParsed,
    agentPlan,
  };
}

async function chatTurnDoResolveDirectUrlsNode(state: ChatTurnGraphState) {
  const { projectId, directUrls, cookiesFromBrowser } = state;

  if (directUrls.length > 0) {
    emitChatStage({ stage: "resolve", detail: `${directUrls.length}` });
  }

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
  const links: ChatLinkCard[] = [];

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
        if (!isLikelyVideoUrl(u)) {
          links.push({ url: u, title: u, snippet: null });
          continue;
        }
        videos.push({ url: u, title: u, description: null, thumbnail: null, duration_s: null, extractor: "unknown", id: "" });
      }
    } else {
      for (const u of directUrls) {
        if (!isLikelyVideoUrl(u)) {
          links.push({ url: u, title: u, snippet: null });
          continue;
        }
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
  if (links.length > 0) {
    blocks.push({ type: "links", links });
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
  const usedKeys = recentSuggestedUrlKeys(state.recent || []);
  const addUsed = (url: string) => {
    const key = normalizeUrlForDedup(url);
    if (key) usedKeys.add(key);
  };
  for (const v of videos) addUsed(v.url);
  for (const b of blocks) {
    const type = str((b as any)?.type);
    if (type === "links") {
      const links = Array.isArray((b as any)?.links) ? ((b as any).links as any[]) : [];
      for (const l of links) addUsed(str(l?.url));
    }
    if (type === "videos") {
      const vids = Array.isArray((b as any)?.videos) ? ((b as any).videos as any[]) : [];
      for (const v of vids) addUsed(str(v?.url));
    }
  }

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
  const noWebProvider = !hasGoogle && !hasExa;
  const currentPass = typeof state.searchPass === "number" && Number.isFinite(state.searchPass) ? state.searchPass : 0;
  const maxRounds = currentPass <= 0 ? 3 : 2; // 2nd+ pass should be more targeted
  const nextSearchPass = currentPass + 1;
  emitChatStage({ stage: "search", pass: nextSearchPass, max_passes: CHAT_MAX_SEARCH_PASSES });
  const primaryFocus = expandFocusTokens(focusTokensFromText(userText));
  const fallbackFocus = expandFocusTokens(focusTokensFromText(agentPlan.search_queries.join(" ")));
  const focusForQueryPick = primaryFocus.length > 0 ? primaryFocus : fallbackFocus;

  const rawQueries = agentPlan.search_queries.map((q) => str(q)).filter(Boolean);
  const pickedQueries = rawQueries.filter((q) => containsAnyToken(q, focusForQueryPick));
  const queries = (pickedQueries.length > 0 ? pickedQueries : rawQueries).slice(0, 3);

  type SearchCandidate = {
    url: string;
    title: string;
    snippet: string | null;
    score: number;
    thumbnail?: string | null;
    duration_s?: number | null;
  };
  const videoCandidatesByUrl = new Map<string, SearchCandidate>();
  const linkCandidatesByUrl = new Map<string, SearchCandidate>();

  const hintText = `${userText} ${rawQueries.join(" ")} ${(state.directUrls || []).join(" ")}`;
  const intent = detectChatSearchIntent(hintText);
  const constraintHints = inferConstraintHints(hintText);
  const wantsFootage = /画面|素材|b-roll|镜头|五分钟|5分钟|5\s*min/i.test(hintText);
  const wantsVoice = /配音|旁白|tts|声音|哈基米/i.test(hintText);
  const wantsBgm = /bgm|配乐|音乐|哈基米/i.test(hintText);
  const multiAsset = wantsFootage && (wantsVoice || wantsBgm);

  const wantsExternal = /外站|站外|youtube|youtu|tiktok|douyin|instagram|twitter|x\\.com/i.test(hintText);
  const wantsBilibili = /b站|bilibili|b23\\.tv|bilibili\\.com|\\bbv[0-9a-z]{6,}/i.test(hintText);
  const wantsYoutube = /youtube|youtu|油管/i.test(hintText);

  const preferBilibili = intent === "video" && wantsBilibili && !wantsExternal;
  const preferYoutube = intent === "video" && (wantsYoutube || wantsExternal);
  const allowBilibiliOnly = noWebProvider;

  const platformBoost = (url: string): number => {
    if (intent !== "video") return 0;
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

  let mainQuery = str(queries[0]);
  if (constraintHints.wants_license && intent !== "video") {
    const hasLicenseToken = /免版权|可商用|cc0|royalty[- ]?free|copyright[- ]?free/i.test(mainQuery);
    if (!hasLicenseToken) mainQuery = `${mainQuery} 免版权 可商用`;
  }

  const rounds: Array<{ label: string; query: string }> = [];
  const seenRound = new Set<string>();
  const pushRound = (label: string, q: string) => {
    const q0 = str(q);
    if (!q0) return;
    if (seenRound.has(q0)) return;
    seenRound.add(q0);
    rounds.push({ label, query: q0 });
  };

  if (intent === "video") {
    const hasExplicitSiteFilter =
      /\bsite:/i.test(mainQuery) || /(bilibili\.com|b23\.tv|youtube\.com|youtu\.be)/i.test(mainQuery);
    const canApplySiteLayer = !!mainQuery && !hasExplicitSiteFilter;
    const order: Array<"broad" | "bilibili" | "youtube"> = preferBilibili
      ? ["bilibili", "broad", "youtube"]
      : preferYoutube
        ? ["youtube", "broad", "bilibili"]
        : ["broad", "bilibili", "youtube"];

    const queryByKind = {
      broad: mainQuery,
      bilibili: canApplySiteLayer ? `${mainQuery} site:bilibili.com` : "",
      youtube: canApplySiteLayer ? `${mainQuery} site:youtube.com` : "",
    };

    for (const k of order) pushRound(k, queryByKind[k]);
  } else {
    pushRound("broad", mainQuery);
    if (intent === "image") pushRound("images", `${mainQuery} 表情包 gif png 贴纸 sticker`);
    if (intent === "audio") pushRound("audio", `${mainQuery} bgm 音效 配音 免版权`);
    if (intent === "web") pushRound("sites", `${mainQuery} 网站 资料 资源`);
  }

  for (const q of queries.slice(1)) {
    if (rounds.length >= maxRounds) break;
    pushRound("alt", q);
  }

  const searchErrors: string[] = [];
  const recordSearchError = (msg: string) => {
    const m = str(msg);
    if (!m) return;
    if (searchErrors.includes(m)) return;
    if (searchErrors.length >= 3) return;
    searchErrors.push(m);
  };

  for (const { query } of rounds.slice(0, maxRounds)) {
    emitChatStage({ stage: "search_query", detail: query });
    let results: WebSearchResult[] = [];
    try {
      results = allowBilibiliOnly
        ? await withTimeout(bilibiliSearchVideos({ keyword: query, numResults: 12 }), 12_000)
        : (
            await webSearch({
              query,
              numResults: 12,
              googleApiKey: googleCseApiKey,
              googleCx: googleCseCx,
              exaApiKey,
            })
          ).results;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordSearchError(msg);
      const biliBlocked = allowBilibiliOnly && /HTTP\s*412|risk control|风控|banned/i.test(msg);
      if (biliBlocked) break;
      continue;
    }
    if (results.length === 0) continue;

    const isResourceQuery = /配音|旁白|tts|bgm|配乐|音乐|音效|sfx|教程|从哪|哪里/i.test(query);
    const targetMap =
      multiAsset && isResourceQuery ? linkCandidatesByUrl : intent === "video" ? videoCandidatesByUrl : linkCandidatesByUrl;

    for (const r of results) {
      const u = str(r.url);
      const t = str(r.title) || u;
      const isVideo = isLikelyVideoUrl(u);
      if (intent === "video" && !isVideo) continue;
      if (!allowBilibiliOnly && intent !== "video" && isVideo) continue;

      const hay = `${t} ${u} ${str(r.snippet)}`;
      const score = scoreByTokens(hay, primaryFocus, fallbackFocus) + platformBoost(u);
      if (score <= 0) continue;

      const prev = targetMap.get(u);
      if (!prev || prev.score < score) {
        targetMap.set(u, {
          url: u,
          title: t.trim() || u,
          snippet: str(r.snippet) || null,
          score,
          thumbnail: str((r as any)?.thumbnail) || null,
          duration_s: typeof (r as any)?.duration_s === "number" ? (r as any).duration_s : null,
        });
      }
    }

    // Enough candidates; avoid extra web search calls.
    if (intent === "video" && videoCandidatesByUrl.size >= 18) break;
  }

  const rankedVideos = Array.from(videoCandidatesByUrl.values()).sort((a, b) => b.score - a.score);
  const rankedLinks = Array.from(linkCandidatesByUrl.values()).sort((a, b) => b.score - a.score);

  if (rankedVideos.length === 0 && rankedLinks.length === 0) {
    const biliSearchUrl = (q: string) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`;
    const ytSearchUrl = (q: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

    const qs = uniqStrings([
      "笔给你你来写",
      "哈基米 配音 免费 教程",
      "哈基米 BGM 纯音乐",
      "5分钟 画面素材 B-roll",
    ]);

    const links: ChatLinkCard[] = [];
    for (const q of qs.slice(0, 4)) {
      links.push({ url: biliSearchUrl(q), title: `B站搜索：${q}`, snippet: "点开后直接在浏览器里筛选最合适的结果。" });
    }
    links.push({
      url: ytSearchUrl(`${qs[0] || "笔给你你来写"} 参考 风格`),
      title: "YouTube 搜索：风格参考",
      snippet: "站外补搜（需要的话可在 Settings 配 Exa/Google 让它自动化）。",
    });

    const hasLinks = blocks.some((b) => b && typeof b === "object" && (b as any).type === "links");
    if (!hasLinks) blocks.push({ type: "links", links });
    if (hasLinks) {
      for (const b of blocks) {
        if (b && typeof b === "object" && (b as any).type === "links") {
          (b as any).links = links;
          break;
        }
      }
    }

    const prefix = ensureUserFacingReplyText(agentPlan.reply);
    const errHint = searchErrors.length > 0 ? `\n\n（本轮搜索失败：${searchErrors[0]}）` : "";
    agentPlan.reply = [
      prefix,
      "",
      "我这边暂时没能拿到可直接渲染成卡片的搜索结果（常见原因：B 站接口触发风控、或未配置 Exa/Google 搜索）。",
      "你可以先点下面这些“搜索入口链接”直接打开筛选；或者把该 UP 主主页 / 任意 BV 链接贴给我，我就能基于参考视频继续找同类素材。",
      noWebProvider ? "（建议：Settings 里配置 Exa API Key 或 Google CSE，可显著提高命中率并支持站外多轮搜索。）" : "",
      errHint,
    ]
      .filter(Boolean)
      .join("\n");

    return { agentPlan, blocks, videos, directResolveCache, searchPass: nextSearchPass };
  }

  const selected: typeof rankedVideos = [];
  const selectedKeys = new Set<string>();
  for (const cand of rankedVideos) {
    if (selected.length >= 6) break;
    const key = normalizeUrlForDedup(cand.url);
    if (!key) continue;
    if (usedKeys.has(key)) continue;
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    selected.push(cand);
  }
  if (selected.length < 6) {
    for (const cand of rankedVideos) {
      if (selected.length >= 6) break;
      const key = normalizeUrlForDedup(cand.url);
      if (!key) continue;
      if (selectedKeys.has(key)) continue;
      selectedKeys.add(key);
      selected.push(cand);
    }
  }

  const selectedLinks: typeof rankedLinks = [];
  const selectedLinkKeys = new Set<string>();
  for (const cand of rankedLinks) {
    if (selectedLinks.length >= 6) break;
    const key = normalizeUrlForDedup(cand.url);
    if (!key) continue;
    if (usedKeys.has(key)) continue;
    if (selectedLinkKeys.has(key)) continue;
    selectedLinkKeys.add(key);
    selectedLinks.push(cand);
  }

  // Non-video intent: return links only unless the user clearly asked for multiple asset types in one turn.
  if (intent !== "video" && !multiAsset) {
    const links: ChatLinkCard[] = [];
    const seen = new Set<string>();
    for (const cand of selectedLinks) {
      if (links.length >= 6) break;
      const u = cand.url;
      const key = normalizeUrlForDedup(u);
      if (!u || !key || seen.has(key)) continue;
      seen.add(key);
      links.push({ url: u, title: cand.title || u, snippet: cand.snippet || null });
    }

    if (links.length === 0) {
      agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n我暂时没搜到合适的网站结果。你能补充 1 句话吗：你想要的是“表情包/图片/GIF 资源包”，还是“配音/BGM/音效网站”？也可以指定平台（GitHub/站点名/语言）。`;
      return { agentPlan, blocks, videos, directResolveCache, searchPass: nextSearchPass };
    }

    const hasLinks = blocks.some((b) => b && typeof b === "object" && (b as any).type === "links");
    if (!hasLinks) blocks.push({ type: "links", links });
    if (hasLinks) {
      for (const b of blocks) {
        if (b && typeof b === "object" && (b as any).type === "links") {
          (b as any).links = links;
          break;
        }
      }
    }

    return { agentPlan, blocks, videos, directResolveCache, searchPass: nextSearchPass };
  }

  // Multi-asset: also render a links block (tutorials/resources), then continue hydrating videos below.
  if (selectedLinks.length > 0) {
    const links: ChatLinkCard[] = [];
    const seen = new Set<string>();
    for (const cand of selectedLinks) {
      if (links.length >= 6) break;
      const u = cand.url;
      const key = normalizeUrlForDedup(u);
      if (!u || !key || seen.has(key)) continue;
      seen.add(key);
      links.push({ url: u, title: cand.title || u, snippet: cand.snippet || null });
    }

    if (links.length > 0) {
      const hasLinks = blocks.some((b) => b && typeof b === "object" && (b as any).type === "links");
      if (!hasLinks) blocks.push({ type: "links", links });
      if (hasLinks) {
        for (const b of blocks) {
          if (b && typeof b === "object" && (b as any).type === "links") {
            (b as any).links = links;
            break;
          }
        }
      }
    }
  }

  const existing = new Set(videos.map((v) => normalizeUrlForDedup(v.url)).filter(Boolean));
  let unresolved = 0;
  for (const cand of selected) {
    const u = cand.url;
    const key = normalizeUrlForDedup(u);
    if (!u || !key) continue;
    if (existing.has(key)) continue;
    existing.add(key);

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
      videos.push({
        url: u,
        title: fallbackTitle,
        description: cand.snippet || null,
        thumbnail: cand.thumbnail || null,
        duration_s: typeof cand.duration_s === "number" ? cand.duration_s : null,
        extractor: "unknown",
        id: "",
      });
    }
  }

  if (videos.length === 0) {
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n我搜到了一些结果，但相关度不高，所以先不乱贴链接。你能补充 1 句话吗：你要的是“表情包/图片/GIF 资源包”，还是“相关的视频素材”？也可以直接给一个示例链接/BV 号，我会按它找同类。`;
    return { agentPlan, blocks, videos, directResolveCache, searchPass: nextSearchPass };
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

  return { agentPlan, blocks, videos, directResolveCache, searchPass: nextSearchPass };
}

async function chatTurnReviewRefineNode(state: ChatTurnGraphState) {
  const { projectId, userText, recent, thinkEnabled, useGeminiNative, baseUrl, model, geminiApiKey } = state;

  const agentPlan: ChatAgentPlan = state.agentPlan || {
    reply: ensureUserFacingReplyText(""),
    prompt_draft: null,
    should_search: false,
    search_queries: [],
  };

  if (state.needsConsent) return { searchAgain: false };
  if (!thinkEnabled) return { searchAgain: false };

  const pass = typeof state.searchPass === "number" && Number.isFinite(state.searchPass) ? state.searchPass : 0;
  // Only review after at least one search pass; stop looping at max passes.
  if (pass <= 0) return { searchAgain: false };
  if (pass >= CHAT_MAX_SEARCH_PASSES) return { searchAgain: false };

  emitChatStage({ stage: "review", pass, max_passes: CHAT_MAX_SEARCH_PASSES });

  const blocks: any[] = Array.isArray(state.blocks) ? state.blocks : [];
  const videos: ChatVideoCard[] = Array.isArray(state.videos) ? state.videos : [];

  const linkBlock = blocks.find((b) => b && typeof b === "object" && (b as any).type === "links");
  const videoBlock = blocks.find((b) => b && typeof b === "object" && (b as any).type === "videos");

  const links = Array.isArray((linkBlock as any)?.links) ? ((linkBlock as any).links as any[]) : [];
  const vids = Array.isArray((videoBlock as any)?.videos) ? ((videoBlock as any).videos as any[]) : [];

  const usedKeys = recentSuggestedUrlKeys(recent || []);
  const avoidUrls: string[] = [];
  for (const key of usedKeys) {
    if (avoidUrls.length >= 30) break;
    avoidUrls.push(key);
  }

  const presentLinks = links
    .slice(0, 8)
    .map((l) => ({
      title: typeof l?.title === "string" ? l.title : "",
      url: typeof l?.url === "string" ? l.url : "",
      snippet: typeof l?.snippet === "string" ? l.snippet : null,
    }))
    .filter((l) => !!str(l.url));

  const presentVideos = (vids.length > 0 ? vids : videos)
    .slice(0, 8)
    .map((v: any) => ({
      title: typeof v?.title === "string" ? v.title : "",
      url: typeof v?.url === "string" ? v.url : "",
      description: typeof v?.description === "string" ? v.description : null,
    }))
    .filter((v: any) => !!str(v.url));

  const intent = detectChatSearchIntent(`${userText} ${agentPlan.search_queries.join(" ")}`);
  const constraints = inferConstraintHints(userText);
  const focusTokens = focusTokensFromText(userText).slice(0, 12);

  // Heuristic early-stop: avoid burning all passes when we already have enough candidates.
  // The loop is capped by CHAT_MAX_SEARCH_PASSES, but the review model can still be overly eager.
  const candidateCount = intent === "video" ? presentVideos.length : presentLinks.length;
  const enoughCandidates = intent === "video" ? candidateCount >= 4 : candidateCount >= 6;
  if (enoughCandidates) return { searchAgain: false };

  const systemPrompt = [
    "You are VidUnpack Chat (视频拆解箱对话助手).",
    "You are in the REVIEW step after a web-search pass.",
    "Task: evaluate whether current candidates match the user's exact constraints (asset type + topic + licensing + platforms). Then decide ONE of:",
    "- stop (search_again=false): results are good enough to present",
    "- refine (search_again=true): propose 1-3 refined search_queries for ONE more targeted pass",
    "- ask_user (search_again=false): ask ONE clarifying question if constraints are underspecified",
    "Rules:",
    "- Output JSON ONLY (no markdown).",
    '- Schema: { \"search_again\": boolean, \"search_queries\"?: string[], \"ask_user\"?: string, \"checks\"?: object, \"missing\"?: string[], \"decision\"?: string, \"notes\"?: string }',
    "- search_again=true only if another pass is likely to improve relevance.",
    "- If user intent is ambiguous, set search_again=false and provide ask_user (1 short clarifying question).",
    "- If user has licensing requirements (e.g. 免版权/可商用/CC0), do NOT assume. Mark as 'unknown' unless candidates explicitly mention license terms. Prefer asking the user what they mean by '免版权' if needed.",
    "- If providing search_queries, keep them concise, MUST include the core topic token(s) from user_text, and avoid repeating previous queries.",
    "- Avoid suggesting URLs already shown before (see avoid_urls).",
    "- Do NOT write progress phrases like '我再补搜一轮…' into any user-facing reply here.",
    "",
    `intent=${intent}`,
    `pass=${pass}`,
    `max_passes=${CHAT_MAX_SEARCH_PASSES}`,
    `remaining_passes=${Math.max(0, CHAT_MAX_SEARCH_PASSES - pass)}`,
    "",
    "INPUT:",
    JSON.stringify(
      {
        user_text: userText,
        focus_tokens: focusTokens,
        constraint_hints: constraints,
        previous_queries: agentPlan.search_queries,
        candidates: { links: presentLinks, videos: presentVideos },
        avoid_urls: avoidUrls,
      },
      null,
      2,
    ),
  ].join("\n");

  const recentTail = Array.isArray(recent) ? recent.slice(Math.max(0, recent.length - 6)) : [];
  const contents = [
    { role: "user", parts: [{ text: systemPrompt }] },
    ...recentTail.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }],
    })),
  ];

  const openAiMessages: OpenAIChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentTail.map((m) => ({
      role: toOpenAiRole(m.role),
      content: m.content || "",
    })),
  ];

  let reviewPayload: any;
  try {
    if (useGeminiNative) {
      const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, baseUrl);
      url.searchParams.set("key", geminiApiKey);
      reviewPayload = await fetchJson<any>(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
            ...(GEMINI_THINKING_BUDGET > 0 ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } } : {}),
          },
        }),
      });
    } else {
      reviewPayload = await callChatCompletions({
        baseUrl,
        apiKey: geminiApiKey,
        model,
        messages: openAiMessages,
        temperature: 0.2,
        maxTokens: 1024,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n（复盘步骤暂不可用：${String(msg).slice(0, 160)}）`;
    return { searchAgain: false, reviewPayload: { ok: false, error: msg }, reviewText: "", reviewParsed: null };
  }

  const reviewText = useGeminiNative ? extractGeminiText(reviewPayload) : extractChatCompletionsText(reviewPayload);
  const reviewParsed = tryParseJson(reviewText);
  const obj = reviewParsed && typeof reviewParsed === "object" ? (reviewParsed as any) : null;
  const searchAgain = !!obj?.search_again;
  const nextQueriesRaw = Array.isArray(obj?.search_queries) ? obj.search_queries : [];
  const nextQueries = uniqStrings(nextQueriesRaw.map((s: any) => String(s))).filter(Boolean).slice(0, 4);
  const askUser = typeof obj?.ask_user === "string" ? obj.ask_user.trim() : "";

  if (searchAgain && nextQueries.length > 0) {
    agentPlan.should_search = true;
    agentPlan.search_queries = nextQueries;
    emitChatStage({ stage: "refine", detail: nextQueries.join(" | "), pass: pass + 1, max_passes: CHAT_MAX_SEARCH_PASSES });
    return { agentPlan, searchAgain: true, reviewPayload, reviewText, reviewParsed };
  }

  if (!searchAgain && askUser) {
    agentPlan.should_search = false;
    agentPlan.search_queries = [];
    agentPlan.reply = `${ensureUserFacingReplyText(agentPlan.reply)}\n\n${askUser}`;
    return { agentPlan, searchAgain: false, reviewPayload, reviewText, reviewParsed };
  }

  return { searchAgain: false, reviewPayload, reviewText, reviewParsed };
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
  const searchPass = typeof state.searchPass === "number" && Number.isFinite(state.searchPass) ? state.searchPass : 0;
  const searchAgain = state.searchAgain === true;
  const reviewText = typeof state.reviewText === "string" ? state.reviewText : "";
  const reviewParsed = state.reviewParsed ?? null;
  const reviewPayload = state.reviewPayload ?? null;

  emitChatStage({ stage: "saving" });

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
          search_passes: searchPass,
          search_again: searchAgain,
          videos,
          blocks,
          llm: { text: llmText, parsed: llmParsed, payload: llmPayload },
          review: { text: reviewText, parsed: reviewParsed, payload: reviewPayload },
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

  emitChatStage({ stage: "done" });

  return { debugArtifact, assistantMessage };
}

function routeAfterReviewRefine(state: ChatTurnGraphState): "exa_search_and_resolve" | "review" {
  const pass = typeof state.searchPass === "number" && Number.isFinite(state.searchPass) ? state.searchPass : 0;
  if (state.searchAgain === true && pass < CHAT_MAX_SEARCH_PASSES) return "exa_search_and_resolve";
  return "review";
}

function candidateId(kind: AgentCandidateKind, url: string): string {
  const u = String(url || "").trim();
  const norm = normalizeUrlForDedup(u) || u;
  const h = sha1Hex(norm).slice(0, 12);
  return `${kind}_${h}`;
}

function buildToolAgentTools(): OpenAIToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "search_bilibili_videos",
        description: "Search bilibili videos (bilibili.com/video or b23.tv). Returns candidate IDs.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            num_results: { type: "number", description: "1-20" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_video_sites",
        description:
          "Search multiple video sites (YouTube/TikTok/Douyin/Kuaishou/Vimeo/etc). Returns candidate IDs (videos).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            num_results: { type: "number", description: "1-20" },
            sites: {
              type: "array",
              description: "Optional site domain allowlist, e.g. [\"youtube.com\",\"tiktok.com\"].",
              items: { type: "string" },
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_web",
        description: "General web search. Returns candidate IDs (links).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            num_results: { type: "number", description: "1-20" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "resolve_url",
        description: "Resolve a URL to metadata (title/thumbnail/description/duration) via yt-dlp (requires consent). Returns/updates a candidate.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
      },
    },
  ];
}

async function execToolCall(
  state: ChatToolAgentGraphState,
  call: OpenAIChatToolCall,
): Promise<{ toolMessage: OpenAIChatMessage; candidates: AgentCandidate[]; needsConsent?: boolean }> {
  const name = String(call?.function?.name || "").trim();
  const argsObj = tryParseJsonObject(String(call?.function?.arguments || "")) || {};
  const outCandidates: AgentCandidate[] = [];

  if (name === "search_bilibili_videos") {
    const consent = await getConsent(state.projectId);
    if (!consent?.consented) {
      return {
        toolMessage: { role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ ok: false, needs_consent: true }) },
        candidates: [],
        needsConsent: true,
      };
    }

    const query = str(argsObj?.query);
    const numResults = Math.max(1, Math.min(20, Math.floor(Number(argsObj?.num_results || 10))));
    let q = query;
    const hasSite = /\bsite:/i.test(q);
    if (!hasSite) q = `${q} site:bilibili.com/video`;

    emitChatStage({ stage: "search_query", detail: `bilibili: ${q}` });
    const hasGoogle = !!str(state.googleCseApiKey) && !!str(state.googleCseCx);
    const hasExa = !!str(state.exaApiKey);
    let results: WebSearchResult[] = [];
    try {
      results = hasGoogle || hasExa
        ? (
            await webSearch({
              query: q,
              numResults: Math.min(20, numResults),
              googleApiKey: state.googleCseApiKey,
              googleCx: state.googleCseCx,
              exaApiKey: state.exaApiKey,
              prefer: str(state.googleCseApiKey) && str(state.googleCseCx) ? "google_cse" : "exa",
            })
          ).results
        : await bilibiliSearchVideos({ keyword: query, numResults: Math.min(20, numResults) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        toolMessage: { role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ ok: false, error: msg, query: q }) },
        candidates: [],
      };
    }

    const candidates: Array<{ id: string; url: string; title: string; snippet?: string | null }> = [];
    for (const r of results) {
      const url = str(r.url);
      const lower = url.toLowerCase();
      if (!url) continue;
      if (lower.includes("bilibili.com/read") || lower.includes("bilibili.com/opus")) continue;
      const isVideo = lower.includes("bilibili.com/video/") || lower.includes("b23.tv/");
      if (!isVideo) continue;
      const id = candidateId("video", url);
      const title = str(r.title) || url;
      const snippet = typeof r.snippet === "string" ? r.snippet : null;
      candidates.push({ id, url, title, snippet });
      outCandidates.push({
        id,
        kind: "video",
        url,
        title,
        snippet,
        thumbnail: str((r as any)?.thumbnail) || null,
        duration_s: typeof (r as any)?.duration_s === "number" ? (r as any).duration_s : null,
        extractor: "bilibili",
      });
    }

    return {
      toolMessage: {
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify({ ok: true, query: q, candidates }),
      },
      candidates: outCandidates,
    };
  }

  if (name === "search_video_sites") {
    const consent = await getConsent(state.projectId);
    if (!consent?.consented) {
      return {
        toolMessage: { role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ ok: false, needs_consent: true }) },
        candidates: [],
        needsConsent: true,
      };
    }

    const hasGoogle = !!str(state.googleCseApiKey) && !!str(state.googleCseCx);
    const hasExa = !!str(state.exaApiKey);
    if (!hasGoogle && !hasExa) {
      return {
        toolMessage: {
          role: "tool",
          tool_call_id: call.id,
          name,
          content: JSON.stringify({ ok: false, error: "web search not configured (set Exa or Google CSE in Settings)" }),
        },
        candidates: [],
      };
    }

    const query = str(argsObj?.query);
    const numResults = Math.max(1, Math.min(20, Math.floor(Number(argsObj?.num_results || 10))));
    const sitesRaw = Array.isArray(argsObj?.sites) ? (argsObj.sites as any[]).map((s) => str(s).toLowerCase()).filter(Boolean) : [];
    const sites = sitesRaw.length > 0
      ? sitesRaw
      : ["youtube.com", "youtu.be", "tiktok.com", "douyin.com", "kuaishou.com", "vimeo.com", "dailymotion.com"];

    const subQueries: Array<{ site: string; q: string }> = [];
    const push = (site: string, q: string) => {
      const s = str(site).toLowerCase();
      const qq = str(q);
      if (!s || !qq) return;
      subQueries.push({ site: s, q: qq });
    };

    for (const s of sites) {
      if (s === "youtube.com" || s === "youtu.be") {
        push("youtube.com", `${query} site:youtube.com (inurl:watch OR inurl:shorts)`);
        continue;
      }
      push(s, `${query} site:${s}`);
    }

    const candidateByUrl = new Map<string, AgentCandidate>();
    const candidatesOut: Array<{ id: string; url: string; title: string; snippet?: string | null }> = [];

    const perSite = Math.max(3, Math.min(8, Math.ceil(numResults / Math.max(1, subQueries.length))));
    for (const sq of subQueries) {
      if (candidatesOut.length >= numResults) break;
      emitChatStage({ stage: "search_query", detail: `video: ${sq.q}` });
      const { results } = await webSearch({
        query: sq.q,
        numResults: Math.min(10, perSite),
        googleApiKey: state.googleCseApiKey,
        googleCx: state.googleCseCx,
        exaApiKey: state.exaApiKey,
        prefer: str(state.googleCseApiKey) && str(state.googleCseCx) ? "google_cse" : "exa",
      });

      for (const r of results) {
        if (candidatesOut.length >= numResults) break;
        const url = str(r.url);
        const lower = url.toLowerCase();
        if (!url) continue;
        if (!isLikelyVideoUrl(url)) continue;
        // Skip common non-video article pages even if hosted on a video platform.
        if (lower.includes("/read") || lower.includes("/opus") || lower.includes("/article") || lower.includes("/blog")) continue;
        const id = candidateId("video", url);
        if (candidateByUrl.has(url)) continue;
        const title = str(r.title) || url;
        const snippet = typeof r.snippet === "string" ? r.snippet : null;
        const cand: AgentCandidate = { id, kind: "video", url, title, snippet };
        candidateByUrl.set(url, cand);
        outCandidates.push(cand);
        candidatesOut.push({ id, url, title, snippet });
      }
    }

    return {
      toolMessage: {
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify({ ok: true, query, sites, candidates: candidatesOut }),
      },
      candidates: outCandidates,
    };
  }

  if (name === "search_web") {
    const consent = await getConsent(state.projectId);
    if (!consent?.consented) {
      return {
        toolMessage: { role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ ok: false, needs_consent: true }) },
        candidates: [],
        needsConsent: true,
      };
    }

    const query = str(argsObj?.query);
    const numResults = Math.max(1, Math.min(20, Math.floor(Number(argsObj?.num_results || 10))));
    emitChatStage({ stage: "search_query", detail: `web: ${query}` });
    const { results } = await webSearch({
      query,
      numResults: Math.min(20, numResults),
      googleApiKey: state.googleCseApiKey,
      googleCx: state.googleCseCx,
      exaApiKey: state.exaApiKey,
      prefer: str(state.googleCseApiKey) && str(state.googleCseCx) ? "google_cse" : "exa",
    });

    const candidates: Array<{ id: string; url: string; title: string; snippet?: string | null }> = [];
    for (const r of results) {
      const url = str(r.url);
      const title = str(r.title) || url;
      if (!url) continue;
      const id = candidateId("link", url);
      const snippet = typeof r.snippet === "string" ? r.snippet : null;
      candidates.push({ id, url, title, snippet });
      outCandidates.push({ id, kind: "link", url, title, snippet });
    }

    return {
      toolMessage: {
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify({ ok: true, query, candidates }),
      },
      candidates: outCandidates,
    };
  }

  if (name === "resolve_url") {
    const url = str(argsObj?.url);
    if (!url) {
      return {
        toolMessage: { role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ ok: false, error: "missing url" }) },
        candidates: [],
      };
    }

    emitChatStage({ stage: "resolve", detail: url });
    const consent = await getConsent(state.projectId);
    if (!consent?.consented) {
      return {
        toolMessage: { role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ ok: false, needs_consent: true, url }) },
        candidates: [],
        needsConsent: true,
      };
    }

    const r = await withTimeout(resolveRemoteInfo(state.projectId, url, state.cookiesFromBrowser), 20_000);
    const isVideo = isLikelyVideoUrl(url);
    const kind: AgentCandidateKind = isVideo ? "video" : "link";
    const id = candidateId(kind, r.info.webpage_url || url);
    const cand: AgentCandidate = {
      id,
      kind,
      url: r.info.webpage_url || url,
      title: r.info.title || url,
      snippet: r.info.description || null,
      thumbnail: r.info.thumbnail || null,
      description: r.info.description || null,
      duration_s: r.info.duration_s ?? null,
      extractor: r.info.extractor || null,
    };
    outCandidates.push(cand);

    return {
      toolMessage: {
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify({ ok: true, info: r.info, candidate: { id: cand.id, url: cand.url } }),
      },
      candidates: outCandidates,
    };
  }

  return {
    toolMessage: {
      role: "tool",
      tool_call_id: call.id,
      name: name || "unknown_tool",
      content: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }),
    },
    candidates: [],
  };
}

async function chatToolAgentInitNode(state: ChatToolAgentGraphState) {
  emitChatStage({ stage: "planning" });

  const profilePrompt = await getProfilePrompt();
  const feedbackPrompt = formatProjectFeedbackForPrompt(await getProjectFeedback(state.projectId));
  const systemPrompt = [
    "You are VidUnpack Agent (视频素材智能助手).",
    "Your job: take the user's creative intent and find matching media sources (videos/links) via tool calls.",
    "Default behavior: do NOT ask clarifying questions. Make reasonable assumptions and proceed. If unsure, state assumptions briefly and continue.",
    `Process: PLAN → DO → REVIEW (repeat up to ${TOOL_AGENT_MAX_PASSES} passes, stop early if enough).`,
    "Rules:",
    "- Do not do 'keyword cleaning' or rewrite the user's input; use the raw user message as ground truth.",
    "- You should call tools to search/resolve before presenting cards, unless the user explicitly asked for non-search discussion.",
    "- Prefer diversity: avoid duplicates / near-duplicates and keep results varied (different creators/keywords).",
    "- If tools report needs_consent, stop and output JSON reply asking the user to confirm external content access.",
    "Tool choice guidance:",
    "- search_bilibili_videos: bilibili video discovery.",
    "- search_video_sites: other video sites discovery (YouTube/TikTok/Douyin/Kuaishou/Vimeo/etc).",
    "- search_web: general web discovery.",
    "- resolve_url: fetch title/thumbnail/description/duration (requires consent).",
    "",
    "Default search strategy (maximize hit-rate):",
    "- If intent includes videos: start with search_bilibili_videos (Chinese) then search_video_sites (external/variety), then resolve_url for top candidates.",
    "- If intent includes audio/BGM/voiceover/SFX: use search_web with explicit site hints (e.g. freesound/pixabay/mixkit) and resolve_url for a few best links.",
    "- Prefer video platforms by default unless user explicitly requests non-video-only assets.",
    "",
    "Output:",
    "- When you are ready to answer, output JSON ONLY (no markdown).",
    '- Schema: { "reply": string, "select"?: { "videos"?: string[], "links"?: string[] }, "scorecard"?: { [id: string]: { "score"?: number, "tags"?: string[], "reason"?: string } }, "dedupe_groups"?: string[][], "notes"?: string }',
    "- IMPORTANT: IDs in select MUST be candidate IDs returned by tools.",
    "- Do not ask user questions; instead proceed with best-effort and put assumptions into reply if needed.",
    ...(profilePrompt ? ["", "User profile (cross-project preferences):", profilePrompt] : []),
    ...(feedbackPrompt ? ["", "User feedback memory (project-scoped):", feedbackPrompt] : []),
  ].join("\n");

  const recentTail = Array.isArray(state.recent) ? state.recent.slice(Math.max(0, state.recent.length - 10)) : [];
  const messages: OpenAIChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentTail
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: toOpenAiRole(m.role), content: String(m.content || "") })),
    { role: "user", content: state.userText },
  ];

  return { messages, needsConsent: false };
}

async function chatToolAgentThinkNode(state: ChatToolAgentGraphState) {
  if (state.needsConsent) return {};

  emitChatStage({ stage: "thinking" });

  if (state.useGeminiNative) {
    const reply =
      "当前 Base URL 是 Gemini 原生接口，暂不支持本项目的“tool-calls agent”模式。请在设置里使用 OpenAI 兼容的中转（Base URL 指向 /v1 或 /openai）后再试。";
    return { final: { reply }, thinkPlan: null, thinkText: "", thinkParsed: null };
  }

  const systemPrompt = [
    "You are VidUnpack Agent (internal THINK step).",
    "You MUST think about the user's request and propose a concrete tool strategy BEFORE any tool calls.",
    "Default behavior: do NOT ask clarifying questions. Make reasonable assumptions and proceed.",
    "Output JSON ONLY (no markdown).",
    'Schema: { "intent": "video"|"audio"|"image"|"web", "platform_preference": "bilibili"|"web"|"mixed", "assumptions": string[], "shot_ideas": string[], "constraints": string[], "tool_strategy": string[], "stop_criteria": string[] }',
    "Rules:",
    "- Do not rewrite the user's message; extract intent/constraints only.",
    "- If user mentions B站视频/BV, platform_preference should be bilibili.",
    "- If user wants broad sources ('全部/外站/全网/不限平台'), set platform_preference=mixed but keep video platforms as first priority.",
    "- If user mentions licensing (免版权/可商用), include it in constraints and mention uncertainty in assumptions (do not claim verified license).",
    "- tool_strategy should explicitly list the tool calls you plan (e.g. search_bilibili_videos -> search_video_sites -> resolve_url).",
  ].join("\n");

  const userText = String(state.userText || "");
  const payload = await callChatCompletions({
    baseUrl: state.baseUrl,
    apiKey: state.geminiApiKey,
    model: state.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.2,
    maxTokens: 512,
    toolChoice: "none",
  });

  const thinkText = extractChatCompletionsText(payload);
  const thinkParsed = tryParseJson(thinkText);
  const thinkPlan = (thinkParsed && typeof thinkParsed === "object" ? (thinkParsed as any) : null) as any;

  // Feed the plan back to the agent as an internal system note to guide tool choice.
  const planNote = thinkText && thinkText.trim() ? thinkText.trim() : "{}";
  const message: OpenAIChatMessage = {
    role: "system",
    content: `Internal plan (do not reveal to user):\n${planNote}`,
  };

  return { thinkPayload: payload, thinkText, thinkParsed, thinkPlan, messages: [message] };
}

async function chatToolAgentDoNode(state: ChatToolAgentGraphState) {
  const pass = (typeof state.pass === "number" && Number.isFinite(state.pass) ? state.pass : 0) + 1;
  emitChatStage({ stage: "search", pass, max_passes: TOOL_AGENT_MAX_PASSES });

  if (state.needsConsent) return {};
  if (state.useGeminiNative) {
    const reply =
      "当前 Base URL 是 Gemini 原生接口，暂不支持本项目的“tool-calls”模式。请在设置里使用 OpenAI 兼容的中转（Base URL 指向 /v1 或 /openai）后再试。";
    return { final: { reply }, pendingToolCalls: [], pass };
  }

  const tools = buildToolAgentTools();
  emitChatStage({ stage: "tool_call", detail: "llm", pass, max_passes: TOOL_AGENT_MAX_PASSES });

  let payload = await callChatCompletions({
    baseUrl: state.baseUrl,
    apiKey: state.geminiApiKey,
    model: state.model,
    messages: state.messages,
    temperature: 0.2,
    maxTokens: 1024,
    tools,
    toolChoice: "auto",
  });

  // First pass should attempt at least one tool call to discover candidates.
  let toolCalls = extractChatCompletionsToolCalls(payload);
  if (toolCalls.length === 0) {
    try {
      payload = await callChatCompletions({
        baseUrl: state.baseUrl,
        apiKey: state.geminiApiKey,
        model: state.model,
        messages: state.messages,
        temperature: 0.2,
        maxTokens: 512,
        tools,
        toolChoice: "required" as any,
      });
      toolCalls = extractChatCompletionsToolCalls(payload);
    } catch {
      // ignore
    }
  }

  const text = extractChatCompletionsText(payload);
  const assistant: OpenAIChatMessage = { role: "assistant", content: text || "" };
  if (toolCalls.length > 0) assistant.tool_calls = toolCalls;

  const iterations = 1;
  return { messages: [assistant], pendingToolCalls: toolCalls, iterations, pass };
}

async function chatToolAgentToolsNode(state: ChatToolAgentGraphState) {
  if (state.needsConsent) return {};
  const calls = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [];
  if (calls.length === 0) return { pendingToolCalls: [] };

  const added: AgentCandidate[] = [];
  const toolMessages: OpenAIChatMessage[] = [];

  for (const call of calls.slice(0, 6)) {
    const name = String(call?.function?.name || "").trim();
    emitChatStage({ stage: "tool_call", detail: name || "tool" });
    try {
      const r = await execToolCall(state, call);
      toolMessages.push(r.toolMessage);
      added.push(...r.candidates);
      if (r.needsConsent) {
        return { messages: toolMessages, candidates: added, pendingToolCalls: [], needsConsent: true };
      }
      emitChatStage({ stage: "tool_result", detail: name || "tool" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toolMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify({ ok: false, error: message }),
      });
    }
  }

  return { messages: toolMessages, candidates: added, pendingToolCalls: [] };
}

async function chatToolAgentReviewNode(state: ChatToolAgentGraphState) {
  const pass = (typeof state.pass === "number" && Number.isFinite(state.pass) ? state.pass : 0) + 1;
  emitChatStage({ stage: "review", pass, max_passes: TOOL_AGENT_MAX_PASSES });

  if (state.needsConsent) {
    const reply = "需要先确认「外部内容访问」授权才能继续搜索/解析。请点确认后，我会自动继续。";
    return { final: { reply }, pendingToolCalls: [], pass };
  }
  if (state.useGeminiNative) return {};

  const tools = buildToolAgentTools();
  const maxed = pass >= TOOL_AGENT_MAX_PASSES;
  emitChatStage({ stage: "tool_call", detail: "llm.review", pass, max_passes: TOOL_AGENT_MAX_PASSES });

  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const digest = candidates
    .slice(0, 30)
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      url: c.url,
      title: c.title,
      snippet: str(c.description) || str(c.snippet) || null,
      extractor: str(c.extractor) || null,
      duration_s: typeof c.duration_s === "number" ? c.duration_s : null,
      thumbnail: str(c.thumbnail) || null,
    }));
  const feedbackPrompt = formatProjectFeedbackForPrompt(await getProjectFeedback(state.projectId));

  const payload = await callChatCompletions({
    baseUrl: state.baseUrl,
    apiKey: state.geminiApiKey,
    model: state.model,
    messages: [
      ...state.messages,
      {
        role: "system",
        content: [
          "REVIEW step.",
          "Evaluate whether current candidates match the user's creative intent.",
          "If not enough and remaining passes > 0, call ONE tool with a refined query to improve relevance/diversity.",
          "- For video intent or when user asked for off-site sources, prefer search_video_sites (or search_bilibili_videos) over generic search_web.",
          "If enough OR remaining passes == 0, output JSON ONLY with { reply, select, scorecard, dedupe_groups } (no markdown) and stop calling tools.",
          "Avoid duplicates / near-duplicates in select.",
          'scorecard schema: { [id: string]: { score?: number (0..1), tags?: string[], reason?: string } }',
          "dedupe_groups schema: string[][] (each group lists candidate ids that are near-duplicates).",
          `pass=${pass}`,
          `max_passes=${TOOL_AGENT_MAX_PASSES}`,
          `remaining_passes=${Math.max(0, TOOL_AGENT_MAX_PASSES - pass)}`,
        ].join("\n"),
      },
      ...(feedbackPrompt
        ? [
            {
              role: "system",
              content: `User feedback memory (project-scoped):\n${feedbackPrompt}`,
            } as OpenAIChatMessage,
          ]
        : []),
      {
        role: "system",
        content: `Candidates digest (for scoring/dedup; ids must match):\n${JSON.stringify(digest, null, 2)}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 1024,
    tools,
    toolChoice: maxed ? ("none" as any) : "auto",
  });

  const text = extractChatCompletionsText(payload);
  const toolCalls = extractChatCompletionsToolCalls(payload);
  const assistant: OpenAIChatMessage = { role: "assistant", content: text || "" };
  if (!maxed && toolCalls.length > 0) assistant.tool_calls = toolCalls;
  const iterations = (state.iterations || 0) + 1;
  return { messages: [assistant], pendingToolCalls: toolCalls, iterations, pass };
}

function routeAfterToolAgentDo(state: ChatToolAgentGraphState): "tools" | "review" {
  if (state.needsConsent) return "review";
  const calls = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [];
  return calls.length > 0 ? "tools" : "review";
}

function routeAfterToolAgentReview(state: ChatToolAgentGraphState): "tools" | "hydrate" {
  if (state.needsConsent) return "hydrate";
  const calls = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [];
  const pass = typeof state.pass === "number" && Number.isFinite(state.pass) ? state.pass : 0;
  if (calls.length > 0 && pass < TOOL_AGENT_MAX_PASSES) return "tools";
  return "hydrate";
}

async function chatToolAgentHydrateNode(state: ChatToolAgentGraphState) {
  if (state.needsConsent) return {};

  emitChatStage({ stage: "resolve", detail: "hydrate" });

  const messages = Array.isArray(state.messages) ? state.messages : [];
  const lastAssistant = [...messages].reverse().find((m) => m && m.role === "assistant");
  const rawText = lastAssistant ? String(lastAssistant.content || "").trim() : "";
  const parsed = tryParseJsonObject(rawText);

  const wanted = parsed && typeof parsed === "object" ? (parsed as any)?.select : null;
  const wantedVideos = Array.isArray(wanted?.videos) ? wanted.videos.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  const wantedLinks = Array.isArray(wanted?.links) ? wanted.links.map((x: any) => String(x || "").trim()).filter(Boolean) : [];

  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const byId = new Map<string, AgentCandidate>();
  for (const c of candidates) if (c && c.id) byId.set(c.id, c);

  const pickIds = (ids: string[], kind: AgentCandidateKind, limit: number): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (!c || c.kind !== kind) continue;
      out.push(id);
      if (out.length >= limit) break;
    }
    if (out.length > 0) return out;
    // fallback: hydrate top candidates to improve UX
    const fallback = candidates.filter((c) => c.kind === kind).slice(0, limit).map((c) => c.id);
    return fallback;
  };

  const idsToHydrate: string[] = [];
  for (const id of pickIds(wantedVideos, "video", 3)) idsToHydrate.push(id);
  for (const id of pickIds(wantedLinks, "link", 2)) idsToHydrate.push(id);

  const updated: AgentCandidate[] = [];

  for (const id of idsToHydrate) {
    const c = byId.get(id);
    if (!c || !c.url) continue;
    const needs =
      !str(c.thumbnail) ||
      !str(c.description) ||
      !str(c.title) ||
      (str(c.title) && str(c.url) && str(c.title) === str(c.url));
    if (!needs) continue;

    try {
      const r = await withTimeout(resolveRemoteInfo(state.projectId, c.url, state.cookiesFromBrowser), 20_000);
      updated.push({
        ...c,
        url: r.info.webpage_url || c.url,
        title: str(r.info.title) || c.title,
        description: str(r.info.description) || c.description || c.snippet || null,
        snippet: c.snippet || str(r.info.description) || null,
        thumbnail: str(r.info.thumbnail) || c.thumbnail || null,
        duration_s: r.info.duration_s ?? c.duration_s ?? null,
        extractor: str(r.info.extractor) || c.extractor || null,
      });
    } catch {
      // best-effort; keep the original candidate
    }
  }

  if (updated.length === 0) return {};
  return { candidates: updated };
}

async function chatToolAgentFinalizeNode(state: ChatToolAgentGraphState) {
  emitChatStage({ stage: "review" });
  if (state.needsConsent) {
    const reply =
      "要开始联网搜索/解析链接前，请先在本项目完成一次「授权确认」（外部内容提示）。完成后再发一句“开始搜”。";
    return { final: { reply }, blocks: [] };
  }

  const messages = Array.isArray(state.messages) ? state.messages : [];
  const lastAssistant = [...messages].reverse().find((m) => m && m.role === "assistant");
  const rawText = lastAssistant ? String(lastAssistant.content || "").trim() : "";

  let final: ChatToolAgentFinal | null = null;
  const parsed = tryParseJsonObject(rawText);
  if (parsed && typeof parsed === "object") {
    final = {
      reply: typeof parsed.reply === "string" ? parsed.reply : "",
      select: parsed.select && typeof parsed.select === "object" ? parsed.select : null,
      scorecard: parsed.scorecard && typeof parsed.scorecard === "object" ? (parsed.scorecard as any) : null,
      dedupe_groups: Array.isArray(parsed.dedupe_groups) ? (parsed.dedupe_groups as any) : null,
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
    };
  }

  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const byId = new Map<string, AgentCandidate>();
  for (const c of candidates) if (c && c.id) byId.set(c.id, c);

  const blocks: any[] = [];

  const wanted = final?.select && typeof final.select === "object" ? final.select : null;
  const pick = (ids: unknown, kind: AgentCandidateKind, limit: number): AgentCandidate[] => {
    const arr = Array.isArray(ids) ? ids : [];
    const out: AgentCandidate[] = [];
    for (const x of arr) {
      const id = String(x || "").trim();
      const c = byId.get(id);
      if (!c || c.kind !== kind) continue;
      out.push(c);
      if (out.length >= limit) break;
    }
    if (out.length > 0) return out;
    // fallback
    return candidates.filter((c) => c.kind === kind).slice(0, limit);
  };

  const defaultVideoLimit = 3;
  const defaultLinkLimit = 4;

  const videosPicked = pick(wanted?.videos, "video", defaultVideoLimit);
  const linksPicked = pick(wanted?.links, "link", defaultLinkLimit);
  const scorecard = final?.scorecard && typeof final.scorecard === "object" ? final.scorecard : null;
  const scoreFor = (id: string) => {
    if (!scorecard) return null;
    const it = (scorecard as any)[id];
    if (!it || typeof it !== "object") return null;
    const score = typeof it.score === "number" && Number.isFinite(it.score) ? it.score : null;
    const tags = Array.isArray(it.tags) ? it.tags.map((s: any) => String(s)).filter(Boolean).slice(0, 8) : null;
    const reason = typeof it.reason === "string" ? it.reason : null;
    return { score, tags, reason };
  };

  if (videosPicked.length > 0) {
    const videos: ChatVideoCard[] = videosPicked.map((c) => {
      const sc = scoreFor(c.id);
      return {
        url: c.url,
        title: c.title || c.url,
        description: c.description || c.snippet || null,
        thumbnail: c.thumbnail || null,
        duration_s: typeof c.duration_s === "number" ? c.duration_s : null,
        extractor: c.extractor || (c.url.includes("bilibili") ? "bilibili" : "unknown"),
        id: "",
        match_score: sc?.score ?? null,
        match_tags: sc?.tags ?? null,
        match_reason: sc?.reason ?? null,
      };
    });
    blocks.push({ type: "videos", videos });
  }
  if (linksPicked.length > 0) {
    const links: ChatLinkCard[] = linksPicked.map((c) => {
      const sc = scoreFor(c.id);
      return {
        url: c.url,
        title: c.title || c.url,
        snippet: c.snippet || null,
        match_score: sc?.score ?? null,
        match_tags: sc?.tags ?? null,
        match_reason: sc?.reason ?? null,
      };
    });
    blocks.push({ type: "links", links });
  }

  let reply = final?.reply ? ensureUserFacingReplyText(final.reply) : "";
  if (!reply) {
    reply = "我先给你一些候选卡片。你更偏向哪种风格/时长/用途？我可以再继续补搜或换方向。";
  }

  return { final: { reply }, blocks };
}

const chatToolAgentGraph = new StateGraph(ChatToolAgentStateAnnotation)
  .addNode("init", chatToolAgentInitNode)
  .addNode("think", chatToolAgentThinkNode)
  .addNode("do", chatToolAgentDoNode)
  .addNode("tools", chatToolAgentToolsNode)
  .addNode("review", chatToolAgentReviewNode)
  .addNode("hydrate", chatToolAgentHydrateNode)
  .addNode("finalize", chatToolAgentFinalizeNode)
  .addEdge(START, "init")
  .addEdge("init", "think")
  .addEdge("think", "do")
  .addConditionalEdges("do", routeAfterToolAgentDo, {
    tools: "tools",
    review: "review",
  })
  .addEdge("tools", "review")
  .addConditionalEdges("review", routeAfterToolAgentReview, {
    tools: "tools",
    hydrate: "hydrate",
  })
  .addEdge("hydrate", "finalize")
  .addEdge("finalize", END)
  .compile();

const chatTurnLangGraph = new StateGraph(ChatTurnStateAnnotation)
  .addNode("llm_plan", chatTurnPlanNode)
  .addNode("resolve_direct_urls", chatTurnDoResolveDirectUrlsNode)
  .addNode("exa_search_and_resolve", chatTurnDoSearchAndResolveNode)
  .addNode("review_refine", chatTurnReviewRefineNode)
  .addNode("review", chatTurnReviewNode)
  .addNode("persist", chatTurnPersistNode)
  .addEdge(START, "llm_plan")
  .addEdge("llm_plan", "resolve_direct_urls")
  .addEdge("resolve_direct_urls", "exa_search_and_resolve")
  .addEdge("exa_search_and_resolve", "review_refine")
  .addConditionalEdges("review_refine", routeAfterReviewRefine, {
    exa_search_and_resolve: "exa_search_and_resolve",
    review: "review",
  })
  .addEdge("review", "persist")
  .addEdge("persist", END)
  .compile();

async function handleChatTurn(projectId: string, body: any) {
  const pid = String(projectId || "").trim();
  if (!pid) throw new HttpError(400, "missing project id");

  emitChatStage({ stage: "starting" });

  const chatId = str(body?.chat_id);
  if (!chatId) throw new HttpError(400, "missing chat_id");

  const userText = String(body?.message || "").trimEnd();
  if (!userText.trim()) throw new HttpError(400, "missing message");

  const directUrls = extractHttpUrls(userText, 4);
  const wantsAnalysis = wantsVideoAnalysis(userText);

  const attachmentsRaw = Array.isArray(body?.attachments) ? body.attachments : [];
  const attachments = attachmentsRaw
    .map((a: any) => ({
      artifact_id: typeof a?.artifact_id === "string" ? a.artifact_id : "",
      file_name: typeof a?.file_name === "string" ? a.file_name : "",
      mime: typeof a?.mime === "string" ? a.mime : "",
      bytes: typeof a?.bytes === "number" ? a.bytes : null,
    }))
    .filter((a: any) => !!a.artifact_id);

  const thinkEnabled = await getThinkEnabled(pid);

  const geminiApiKey = str(body?.gemini_api_key) || str(body?.api_key) || str(process.env.GEMINI_API_KEY);
  const exaApiKey = str(body?.exa_api_key) || str(body?.api_key) || str(process.env.EXA_API_KEY);
  const googleCseApiKey = str(body?.google_cse_api_key) || str(process.env.GOOGLE_CSE_API_KEY);
  const googleCseCx = str(body?.google_cse_cx) || str(process.env.GOOGLE_CSE_CX);
  const baseUrl = str(body?.base_url) || str(process.env.BASE_URL) || "https://generativelanguage.googleapis.com";
  const model = str(body?.model) || str(body?.default_model) || str(process.env.DEFAULT_MODEL) || "gemini-3-preview";
  const cookiesFromBrowser = str(body?.ytdlp_cookies_from_browser) || str(process.env.YTDLP_COOKIES_FROM_BROWSER) || "";

  const userMessage = await createChatMessage(
    pid,
    chatId,
    "user",
    userText,
    attachments.length > 0 ? { attachments } : undefined,
  );

  const mock = str(process.env.E2E_MOCK_CHAT || process.env.MOCK_CHAT) === "1";
  if (mock) {
    emitChatStage({ stage: "mock" });
    const thumb = escapeDataUrlSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#F2F2F7"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="20" fill="#1D1D1F">Video</text></svg>`,
    );
    const intent = detectChatSearchIntent(userText);
    const wantsFootage = /画面|素材|b-roll|镜头|五分钟|5分钟|5\s*min/i.test(userText);
    const wantsVoice = /配音|旁白|tts|声音|哈基米/i.test(userText);
    const wantsBgm = /bgm|配乐|音乐|哈基米/i.test(userText);
    const multiAsset = intent === "video" && wantsFootage && (wantsVoice || wantsBgm);
    const detectedUrls = extractHttpUrls(userText, 2);
    const url1 = detectedUrls[0] || "https://www.bilibili.com/video/BV1xx411c7mD";
    const url2 = detectedUrls[1] || "https://www.bilibili.com/video/BV1yy411c7mE";

    if (intent !== "video") {
      const links: ChatLinkCard[] = [
        {
          url: "https://github.com/",
          title: "Mock: GitHub (links block)",
          snippet: "（E2E mock）用于验证非视频链接卡片渲染。",
        },
        {
          url: "https://www.wikipedia.org/",
          title: "Mock: Wikipedia (links block)",
          snippet: "（E2E mock）第二条链接。",
        },
      ];
      const assistantMessage = await createChatMessage(pid, chatId, "assistant", "我先给你两条示例链接（mock 模式）。", {
        blocks: [{ type: "links", links }],
      });
      return { ok: true, user_message: userMessage, assistant_message: assistantMessage, mock: true };
    }

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

    const blocks: any[] = [{ type: "videos", videos }];
    if (multiAsset) {
      const links: ChatLinkCard[] = [
        {
          url: "https://search.bilibili.com/all?keyword=%E5%93%88%E5%9F%BA%E7%B1%B3%20%E9%85%8D%E9%9F%B3%20%E5%85%8D%E8%B4%B9%20%E6%95%99%E7%A8%8B",
          title: "Mock: 哈基米配音（免费教程）",
          snippet: "（E2E mock）用于验证“视频 + 资源链接”同屏渲染。",
        },
        {
          url: "https://search.bilibili.com/all?keyword=%E5%93%88%E5%9F%BA%E7%B1%B3%20BGM%20%E7%BA%AF%E9%9F%B3%E4%B9%90",
          title: "Mock: 哈基米 BGM（纯音乐）",
          snippet: "（E2E mock）第二条资源链接卡片。",
        },
      ];
      blocks.push({ type: "links", links });
    }

    const assistantMessage = await createChatMessage(
      pid,
      chatId,
      "assistant",
      multiAsset ? "我先给你两条示例视频卡片 + 两条资源链接（mock 模式）。" : "我先给你两条示例卡片（mock 模式）。",
      { blocks },
    );
    return { ok: true, user_message: userMessage, assistant_message: assistantMessage, mock: true };
  }

  const useGeminiNative = isGeminiNativeBaseUrl(baseUrl);

  if (!geminiApiKey) {
    // No LLM key: provide a deterministic, best-effort bilibili-first search so the app is still usable out of the box.
    // This mode intentionally does NOT claim any "analysis" or model inference.
    const consent = await getConsent(pid);
    if (!consent?.consented) {
      const assistantMessage = await createChatMessage(
        pid,
        chatId,
        "assistant",
        "当前未配置 API Key（Gemini/中转），我可以先用 B 站公开搜索做一个“快速检索版”结果，但仍需要你先完成一次“外部内容确认/授权”。确认后再发一次同样的需求即可。",
      );
      return { ok: true, needs_consent: true, user_message: userMessage, assistant_message: assistantMessage };
    }

    const blocks: any[] = [];
    const videoCards: ChatVideoCard[] = [];
    const linkCards: ChatLinkCard[] = [];

    const pushVideo = (r: WebSearchResult) => {
      const url = str(r?.url);
      if (!url) return;
      const id = (() => {
        const m = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
        return m?.[1] ? m[1] : "";
      })();
      videoCards.push({
        url,
        title: str(r?.title) || url,
        description: typeof r?.snippet === "string" ? r.snippet : null,
        thumbnail: str((r as any)?.thumbnail) || null,
        duration_s: typeof (r as any)?.duration_s === "number" ? (r as any).duration_s : null,
        extractor: "bilibili",
        id,
      });
    };

    const pushLink = (r: WebSearchResult) => {
      const url = str(r?.url);
      if (!url) return;
      linkCards.push({
        url,
        title: str(r?.title) || url,
        snippet: typeof r?.snippet === "string" ? r.snippet : null,
      });
    };

    emitChatStage({ stage: "planning" });

    const safeBili = async (keyword: string, n: number): Promise<WebSearchResult[]> => {
      try {
        emitChatStage({ stage: "search_query", detail: `bilibili(api): ${keyword}` });
        return await withTimeout(bilibiliSearchVideos({ keyword, numResults: n }), 12_000);
      } catch {
        return [];
      }
    };

    // 1) Find the creator / style reference
    const upName = "笔给你你来写";
    const upVideos = await safeBili(`${upName} 哈基米`, 6);

    // 2) Find ~5min footage candidates (bilibili-first, since no web keys)
    const footage = await safeBili("5分钟 画面素材 B-roll 4K 风景", 6);

    // 3) Find voice / BGM hints (tutorials/resources). We provide links; user can pick the simplest/free workflow.
    const voiceHowto = await safeBili("哈基米 配音 生成 教程 免费", 6);
    const bgm = await safeBili("哈基米 BGM 纯音乐", 6);

    for (const r of upVideos.slice(0, 2)) pushVideo(r);
    for (const r of footage.slice(0, 4)) pushVideo(r);

    for (const r of voiceHowto.slice(0, 3)) pushLink(r);
    for (const r of bgm.slice(0, 3)) pushLink(r);

    if (videoCards.length > 0) blocks.push({ type: "videos", videos: videoCards });
    if (linkCards.length > 0) blocks.push({ type: "links", links: linkCards });

    const assistantMessage = await createChatMessage(
      pid,
      chatId,
      "assistant",
      [
        "当前未配置 API Key，所以这是“快速检索版”（不做 AI 分析/推断）。",
        `- 我先给你：${upName} 风格参考视频（2条）+ 约 5 分钟画面素材候选（4条）。`,
        "- 以及：哈基米配音/哈基米BGM 的入门教程/资源入口（各3条），你看哪条最简单免费的，我们再固化成默认流程。",
        "",
        "想要我做到“自动分析UP主视频→推断配音/BGM来源→再继续执行”的闭环：需要在 Settings 配好 API Key（Gemini/中转）。",
      ].join("\n"),
      blocks.length > 0 ? { blocks } : undefined,
    );
    return { ok: true, user_message: userMessage, assistant_message: assistantMessage };
  }

  if (wantsAnalysis) {
    emitChatStage({ stage: "analysis" });
    // If the user asks to analyze "this video", try to run the local clip pipeline + Gemini analysis.
    // We prefer an already-downloaded/ imported input_video; if none exists, we can download from the first URL (when auto_confirm is enabled).
    let inputVideoArtifactId = "";
    try {
      const artifacts = await toolserverJson<ToolserverArtifact[]>(`/projects/${pid}/artifacts`);
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
      const consent = await getConsent(pid);
      if (!consent?.consented) {
        const assistantMessage = await createChatMessage(
          pid,
          chatId,
          "assistant",
          "我可以通过“切片 → Gemini”来分析你发的视频链接，但需要你先完成一次「授权确认」。请先在页面弹窗里确认授权，然后再发一句“开始分析”。",
        );
        return { ok: true, needs_consent: true, user_message: userMessage, assistant_message: assistantMessage };
      }

      // Best-effort: still render a card for what the user pasted.
      try {
        emitChatStage({ stage: "resolve", detail: "analysis" });
        const r = await resolveRemoteInfo(pid, directUrls[0], cookiesFromBrowser);
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
          pid,
          chatId,
          "assistant",
          "我可以做切片分析，但你已关闭“自动确认下载”。请在卡片上点「下载」把视频保存到项目里，然后再发一句“开始分析”。",
          blocks.length > 0 ? { blocks } : undefined,
        );
        return { ok: true, user_message: userMessage, assistant_message: assistantMessage };
      }

      // Auto-download for analysis (user asked to analyze and auto_confirm is enabled).
      try {
        emitChatStage({ stage: "download" });
        const dl = await downloadRemoteMedia(pid, directUrls[0], cookiesFromBrowser);
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
          pid,
          chatId,
          "assistant",
          `下载失败：${msg}\n\n你可以先在卡片上点「下载」重试（或在 Settings 配置 Cookies from browser），下载成功后再发一句“开始分析”。`,
          blocks.length > 0 ? { blocks } : undefined,
        );
        return { ok: true, user_message: userMessage, assistant_message: assistantMessage };
      }
    }

    if (!inputVideoArtifactId) {
      const assistantMessage = await createChatMessage(
        pid,
        chatId,
        "assistant",
        directUrls.length > 0
          ? "我可以做切片分析，但目前项目里还没有可用的视频文件。请先在卡片上点「下载」（或在 Workspace 上传本地视频），然后再发一句“开始分析”。"
          : "我可以做切片分析，但你还没导入视频。请先上传/下载一个视频到项目里，然后再说“分析这个视频”。",
        blocks.length > 0 ? { blocks } : undefined,
      );
      return { ok: true, user_message: userMessage, assistant_message: assistantMessage };
    }

    try {
      emitChatStage({ stage: "analysis" });
      const analysis = await runGeminiVideoAnalysis({
        projectId: pid,
        apiKey: geminiApiKey,
        baseUrl,
        model,
        useGeminiNative,
        inputVideoArtifactId,
      });

      const reply = formatAnalysisForChat(analysis.parsed, analysis.text);
      const assistantMessage = await createChatMessage(pid, chatId, "assistant", reply, {
        blocks,
        analysis_artifact: analysis.artifact,
      });

      return {
        ok: true,
        user_message: userMessage,
        assistant_message: assistantMessage,
        analysis_artifact: analysis.artifact,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const assistantMessage = await createChatMessage(
        pid,
        chatId,
        "assistant",
        `切片分析失败：${msg}\n\n常见原因：未安装 ffmpeg、视频未下载完成、或 Gemini/代理不支持视频输入。你可以先确认 Workspace 里有 input_video，然后在 Workspace → Analysis 手动跑一次。`,
        blocks.length > 0 ? { blocks } : undefined,
      );
      return { ok: true, user_message: userMessage, assistant_message: assistantMessage };
    }
  }

  const history = await getChatMessages(pid, chatId);
  const recent = history.slice(Math.max(0, history.length - 12));

  // Gemini native baseUrl supports generateContent but not our OpenAI-style tool-calls agent.
  // Use the (non-tool) LangGraph flow instead, with bilibili-first search fallback.
  if (useGeminiNative) {
    const turnState = await chatTurnLangGraph.invoke(
      {
        projectId: pid,
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
        searchPass: 0,
        searchAgain: false,
        reviewPayload: null,
        reviewText: "",
        reviewParsed: null,
        agentPlan: null,
        videos: [],
        blocks: [],
        needsConsent: false,
        debugArtifact: null,
        assistantMessage: null,
      },
      { recursionLimit: 50 },
    );

    const assistant = turnState.assistantMessage
      ? turnState.assistantMessage
      : await createChatMessage(pid, chatId, "assistant", ensureUserFacingReplyText("OK"));

    return {
      ok: true,
      needs_consent: !!turnState.needsConsent,
      plan: turnState.plan,
      plan_artifact: turnState.planArtifact,
      user_message: userMessage,
      assistant_message: assistant,
    };
  }

  const plan = thinkEnabled
    ? {
        action: "chat_tool_agent",
        loop: { max_passes: TOOL_AGENT_MAX_PASSES },
        tools: ["search_bilibili_videos", "search_video_sites", "search_web", "resolve_url"],
      }
    : null;
  const planArtifact = plan ? await maybeStorePlan(pid, "chat-tool-agent", plan) : null;

  const agentState = await chatToolAgentGraph.invoke(
    {
      projectId: pid,
      chatId,
      userText,
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
      needsConsent: false,
      messages: [],
      pendingToolCalls: [],
      iterations: 0,
      pass: 0,
      candidates: [],
      final: null,
      blocks: [],
    },
    { recursionLimit: 50 },
  );

  const reply = ensureUserFacingReplyText(agentState.final?.reply || "");
  const blocks = Array.isArray(agentState.blocks) ? agentState.blocks : [];

  const debugArtifact = await toolserverJson<ToolserverArtifact>(`/projects/${pid}/artifacts/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "chat_turn",
      out_path: `chat/turn-${Date.now()}.json`,
      content: JSON.stringify(
        {
          mode: "tool_agent",
          plan,
          plan_artifact_id: planArtifact?.id || null,
          model: { base_url: baseUrl, use_gemini_native: useGeminiNative, model },
          user: { message_id: userMessage.id, text: userText },
          tool_agent: {
            iterations: agentState.iterations || 0,
            pass: agentState.pass || 0,
            needs_consent: !!agentState.needsConsent,
            think: {
              text: agentState.thinkText || "",
              parsed: agentState.thinkParsed ?? null,
              plan: agentState.thinkPlan ?? null,
            },
            final: agentState.final,
            candidates: agentState.candidates || [],
            messages: (agentState.messages || []).map((m) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : "[array]",
              tool_call_id: (m as any).tool_call_id || null,
              name: (m as any).name || null,
              tool_calls: Array.isArray((m as any).tool_calls) ? (m as any).tool_calls : null,
            })),
          },
        },
        null,
        2,
      ),
    }),
  });

  const assistantMessage = await createChatMessage(pid, chatId, "assistant", reply || "OK", {
    blocks,
    debug_artifact: debugArtifact,
  });

  return {
    ok: true,
    needs_consent: agentState.needsConsent,
    plan,
    plan_artifact: planArtifact,
    user_message: userMessage,
    assistant_message: assistantMessage,
  };
}

function writeSse(res: any, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/projects/:projectId/chat/turn/stream", async (req, res) => {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const projectId = String(req.params.projectId || "").trim();
  if (!projectId) {
    writeSse(res, "error", { ok: false, error: "missing project id" });
    res.end();
    return;
  }

  let clientGone = false;
  const markGone = () => {
    clientGone = true;
  };
  res.on("close", markGone);
  req.on("aborted", markGone);

  const canWrite = () => !clientGone && !res.writableEnded && !res.destroyed;
  const safeWrite = (event: string, data: unknown) => {
    if (!canWrite()) return;
    writeSse(res, event, data);
  };

  const emit = (evt: ChatTurnStageEvent) => {
    safeWrite("stage", evt);
  };

  safeWrite("stage", { stage: "connected" });

  try {
    const out = await chatTurnStreamCtx.run({ emit }, async () => handleChatTurn(projectId, req.body));
    safeWrite("final", out);
  } catch (e) {
    if (e instanceof HttpError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 500;
      safeWrite("error", { ok: false, status, error: e.message });
    } else {
      const message = e instanceof Error ? e.message : String(e);
      safeWrite("error", { ok: false, error: message });
    }
  } finally {
    res.end();
  }
});

app.post("/api/projects/:projectId/chat/turn", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    const out = await handleChatTurn(projectId, req.body);
    return res.json(out);
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
