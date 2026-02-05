import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function numEnv(key, fallback) {
  const raw = String(process.env[key] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const orchestratorPort = numEnv("ORCHESTRATOR_PORT", 6790);
const toolserverPort = numEnv("TOOLSERVER_PORT", 6791);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCmd = process.execPath;

function killTree(pid) {
  if (!pid || !Number.isFinite(pid)) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
}

function spawnService(name, cmd, args) {
  const useShell = process.platform === "win32" && (cmd === "npm" || cmd === "npx" || cmd === "npm.cmd" || cmd === "npx.cmd");
  const child = spawn(cmd, args, { cwd: repoRoot, env: process.env, shell: useShell, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  });
  child.unref();
  return child;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchOk(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpOk({ url, label, child, timeoutMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (typeof child.exitCode === "number") throw new Error(`${label} exited early (code ${child.exitCode})`);
    if (await fetchOk(url, 2000)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}: ${url}`);
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  // Start backend services only.
  const tool = spawnService("toolserver", nodeCmd, ["scripts/run-toolserver.mjs"]);
  const orch = spawnService("orchestrator", npmCmd, ["-w", "@vidunpack/orchestrator", "run", "dev:serve"]);

  const shutdown = () => {
    killTree(orch.pid);
    killTree(tool.pid);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  await waitForHttpOk({
    url: `http://127.0.0.1:${toolserverPort}/health`,
    label: "toolserver",
    child: tool,
    timeoutMs: 180_000,
  });
  await waitForHttpOk({
    url: `http://127.0.0.1:${orchestratorPort}/api/health`,
    label: "orchestrator",
    child: orch,
    timeoutMs: 120_000,
  });

  const toolBase = `http://127.0.0.1:${toolserverPort}`;
  const orchBase = `http://127.0.0.1:${orchestratorPort}`;

  const project = await fetchJson(`${toolBase}/projects`, { method: "POST", body: JSON.stringify({ title: `prompt-smoke-${Date.now()}` }) });
  const projectId = String(project.id);
  await fetchJson(`${toolBase}/projects/${projectId}/consent`, {
    method: "POST",
    body: JSON.stringify({ consented: true, auto_confirm: true }),
  });
  const chat = await fetchJson(`${toolBase}/projects/${projectId}/chats`, { method: "POST", body: JSON.stringify({ title: "default" }) });
  const chatId = String(chat.id);

  const message =
    "我要做b站up主“笔给你你来写”那种风格的视频，想要大概五分钟的画面素材，然后帮我找下他的ai配音（哈基米配音）一般是从哪弄的，比较简单和免费的，bgm也选哈基米好了。";

  const out = await fetchJson(`${orchBase}/api/projects/${projectId}/chat/turn`, {
    method: "POST",
    body: JSON.stringify({ chat_id: chatId, message }),
  });

  const reply = out?.assistant_message?.content || "";
  const blocks = Array.isArray(out?.assistant_message?.data?.blocks) ? out.assistant_message.data.blocks : [];
  const debugArtifact = out?.assistant_message?.data?.debug_artifact || null;
  const videos = blocks.find((b) => b?.type === "videos")?.videos || [];
  const links = blocks.find((b) => b?.type === "links")?.links || [];

  console.log("\n=== Assistant Reply (first 12 lines) ===");
  console.log(String(reply).split(/\r?\n/).slice(0, 12).join("\n"));
  console.log("\n=== Blocks Summary ===");
  console.log(`videos=${Array.isArray(videos) ? videos.length : 0}, links=${Array.isArray(links) ? links.length : 0}`);

  if (debugArtifact?.id) {
    try {
      const raw = await fetch(`${toolBase}/projects/${projectId}/artifacts/${debugArtifact.id}/raw`);
      const text = await raw.text();
      const parsed = JSON.parse(text);
      const baseUrl = parsed?.model?.base_url || "";
      const useNative = !!parsed?.model?.use_gemini_native;
      console.log("\n=== Debug (model) ===");
      console.log(`base_url=${baseUrl}`);
      console.log(`use_gemini_native=${useNative}`);
      console.log(`mode=${parsed?.mode || ""}`);
      console.log(`tool_agent.pass=${parsed?.tool_agent?.pass || 0}, iterations=${parsed?.tool_agent?.iterations || 0}`);
      console.log(`candidates=${Array.isArray(parsed?.tool_agent?.candidates) ? parsed.tool_agent.candidates.length : 0}`);
      const finalReply = parsed?.tool_agent?.final?.reply || "";
      if (finalReply) {
        console.log("tool_agent.final.reply (first line):");
        console.log(String(finalReply).split(/\r?\n/)[0]);
      }
    } catch {
      // ignore
    }
  }
  if (Array.isArray(videos) && videos.length) {
    console.log("\nTop video titles:");
    for (const v of videos.slice(0, 6)) console.log(`- ${String(v?.title || "").slice(0, 80)}`);
  }
  if (Array.isArray(links) && links.length) {
    console.log("\nTop links:");
    for (const l of links.slice(0, 6)) console.log(`- ${String(l?.title || "").slice(0, 80)}`);
  }

  shutdown();
}

main().catch((e) => {
  console.error(`[prompt_smoke] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
