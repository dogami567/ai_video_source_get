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

app.post("/api/projects/:projectId/chat/turn", async (req, res) => {
  try {
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) return res.status(400).json({ ok: false, error: "missing project id" });

    const chatId = str(req.body?.chat_id);
    if (!chatId) return res.status(400).json({ ok: false, error: "missing chat_id" });

    const userText = String(req.body?.message || "").trimEnd();
    if (!userText.trim()) return res.status(400).json({ ok: false, error: "missing message" });

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
      const videos: ChatVideoCard[] = [
        {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Mock: 猫咪搞笑素材合集",
          description: "（E2E mock）用于验证卡片渲染与按钮交互。",
          thumbnail: thumb,
          duration_s: 123,
          extractor: "bilibili",
          id: "BV1xx411c7mD",
        },
        {
          url: "https://www.bilibili.com/video/BV1yy411c7mE",
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

    const history = await getChatMessages(projectId, chatId);
    const recent = history.slice(Math.max(0, history.length - 12));

    const systemPrompt = [
      "You are VidUnpack Chat (视频拆解箱对话助手).",
      "Goal: chat with the user to clarify their intent, then search for candidate source videos (prefer bilibili) and present them as cards.",
      "Rules:",
      "- Ask 1-3 clarifying questions if needed.",
      "- When ready, output JSON ONLY (no markdown).",
      "- JSON schema:",
      `  { "reply": string, "prompt_draft"?: string, "should_search"?: boolean, "search_queries"?: string[] }`,
      "- Use Chinese in reply when user is Chinese.",
      "- search_queries should be short and actionable; include platform hints if relevant.",
    ].join("\n");

    const contents = [
      { role: "user", parts: [{ text: systemPrompt }] },
      ...recent.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: `${m.role}: ${m.content}` }],
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
          action: "chat_turn",
          steps: [
            useGeminiNative ? { action: "gemini.generateContent", model } : { action: "chat.completions", model, base_url: baseUrl },
            { action: "maybe_search_and_resolve" },
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
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        }),
      });
    } else {
      llmPayload = await callChatCompletions({
        baseUrl,
        apiKey: geminiApiKey,
        model,
        messages: openAiMessages,
        temperature: 0.4,
        maxTokens: 1024,
      });
    }

    const text = useGeminiNative ? extractGeminiText(llmPayload) : extractChatCompletionsText(llmPayload);
    const parsed = tryParseJson(text);

    const parsedObj = (parsed && typeof parsed === "object" ? (parsed as any) : null) as any;
    const agentPlan: ChatAgentPlan = {
      reply: typeof parsedObj?.reply === "string" ? parsedObj.reply : String(text || "").trim(),
      prompt_draft: typeof parsedObj?.prompt_draft === "string" ? parsedObj.prompt_draft : null,
      should_search: !!parsedObj?.should_search,
      search_queries: Array.isArray(parsedObj?.search_queries) ? parsedObj.search_queries.map((s: any) => String(s)) : [],
    };

    const blocks: any[] = [];
    if (agentPlan.prompt_draft && agentPlan.prompt_draft.trim()) {
      blocks.push({ type: "prompt", title: "Prompt", text: agentPlan.prompt_draft.trim() });
    }

    let videos: ChatVideoCard[] = [];
    let needsConsent = false;

    const directUrls = extractHttpUrls(userText, 4);
    if (directUrls.length > 0) {
      const consent = await getConsent(projectId);
      if (!consent?.consented) {
        agentPlan.reply = `${agentPlan.reply}\n\n要解析你提供的链接前，请先在本项目完成一次「授权确认」（外部内容提示）。`;
        needsConsent = true;
      } else {
        for (const u of directUrls) {
          try {
            const r = await resolveRemoteInfo(projectId, u, cookiesFromBrowser);
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

    const shouldSearch = agentPlan.should_search && agentPlan.search_queries && agentPlan.search_queries.length > 0;
    if (shouldSearch && !needsConsent) {
      const consent = await getConsent(projectId);
      if (!consent?.consented) {
        agentPlan.reply = `${agentPlan.reply}\n\n要开始联网搜索/解析链接前，请先在本项目完成一次「授权确认」（外部内容提示）。`;
        needsConsent = true;
      } else if (!exaApiKey) {
        agentPlan.reply = `${agentPlan.reply}\n\nEXA_API_KEY 未设置：暂时没法联网搜索。你可以先在设置里填 Exa API Key，或直接把候选链接贴给我。`;
      } else {
        const exa = new Exa(exaApiKey);
        const q0 = str(agentPlan.search_queries[0]);
        const query = q0.includes("bilibili.com") ? q0 : `${q0} site:bilibili.com`;
        const raw = await withTimeout(exa.search(query, { numResults: 6 }), 20_000);
        const results = Array.isArray((raw as any)?.results) ? ((raw as any).results as any[]) : [];

        const titleByUrl = new Map<string, string>();
        for (const r0 of results) {
          const u = typeof r0?.url === "string" ? r0.url : "";
          const t = typeof r0?.title === "string" ? r0.title : "";
          if (!u.startsWith("http")) continue;
          if (!t.trim()) continue;
          if (!titleByUrl.has(u)) titleByUrl.set(u, t.trim());
        }

        const urls = uniqStrings(
          results
            .map((r0) => (typeof r0?.url === "string" ? r0.url : ""))
            .filter((u) => u.startsWith("http")),
        ).slice(0, 6);

        const existing = new Set(videos.map((v) => v.url));
        let unresolved = 0;
        for (const u of urls) {
          if (existing.has(u)) continue;
          existing.add(u);

          const fallbackTitle = titleByUrl.get(u) || u;
          try {
            const r = await resolveRemoteInfo(projectId, u, cookiesFromBrowser);
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

        if (unresolved > 0) {
          agentPlan.reply = `${agentPlan.reply}\n\n注：部分链接暂时无法解析封面/标题（可能需要登录态）。可以在卡片上点「解析/下载」重试，或在 Settings 配置 Cookies from browser 后再试。`;
        }

        if (videos.length > 0) {
          blocks.push({ type: "videos", videos });
        } else {
          agentPlan.reply = `${agentPlan.reply}\n\n我搜到了候选链接，但解析标题/封面失败（可能需要登录态或链接不可用）。你也可以直接把 BV 号/链接贴出来，我再帮你解析。`;
        }
      }
    }

    if (videos.length > 0 && !blocks.some((b) => (b && typeof b === "object" ? (b as any).type === "videos" : false))) {
      blocks.push({ type: "videos", videos });
    }

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
            should_search: shouldSearch,
            search_queries: agentPlan.search_queries,
            videos,
            llm: { text, parsed, payload: llmPayload },
          },
          null,
          2,
        ),
      }),
    });

    const assistantMessage = await createChatMessage(projectId, chatId, "assistant", agentPlan.reply || "OK", {
      blocks,
      debug_artifact: debugArtifact,
    });

    return res.json({
      ok: true,
      needs_consent: needsConsent,
      plan,
      plan_artifact: planArtifact,
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
