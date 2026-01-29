import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function hasArg(name) {
  return process.argv.slice(2).includes(name);
}

const mode = hasArg("--backend") ? "backend" : hasArg("--web") ? "web" : "all";

function numEnv(key, fallback) {
  const raw = String(process.env[key] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const webPort = numEnv("WEB_PORT", 6785);
const orchestratorPort = numEnv("ORCHESTRATOR_PORT", 6790);
const toolserverPort = numEnv("TOOLSERVER_PORT", 6791);

const npmCmd = "npm";
const nodeCmd = process.execPath;

function buildChildEnv() {
  const env = { ...process.env };

  if (!String(env.DATA_DIR || "").trim()) env.DATA_DIR = "data";

  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  const pathKey = pathKeys[0] || "PATH";
  // Avoid duplicated PATH/Path variants on Windows that can clobber child PATH resolution.
  for (const k of pathKeys) {
    if (k !== pathKey) delete env[k];
  }
  const currentPath = String(env[pathKey] || "");

  const ffmpegBin = path.join(repoRoot, "tools", "ffmpeg", "bin");
  const ffmpegExe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  if (existsSync(path.join(ffmpegBin, ffmpegExe))) {
    env[pathKey] = `${ffmpegBin}${path.delimiter}${currentPath}`;
  }

  const ytdlpExe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const ytdlpPath = path.join(repoRoot, "tools", "yt-dlp", ytdlpExe);
  if (existsSync(ytdlpPath)) env.YTDLP_PATH = ytdlpPath;

  return env;
}

const childEnv = buildChildEnv();

function runPredev() {
  const args = ["scripts/predev.mjs"];
  if (mode === "all") args.push("--all");
  else if (mode === "backend") args.push("--backend");

  try {
    execFileSync(nodeCmd, args, { cwd: repoRoot, env: childEnv, stdio: "inherit" });
  } catch {
    process.exitCode = 1;
    throw new Error("predev failed (ports in use?)");
  }
}

function prefixLines(prefix, stream, out) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => out.write(`[${prefix}] ${line}\n`));
  return rl;
}

function spawnService(name, cmd, args) {
  const useShell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const child = spawn(cmd, args, { cwd: repoRoot, env: childEnv, shell: useShell, stdio: ["ignore", "pipe", "pipe"] });

  const rls = [];
  if (child.stdout) rls.push(prefixLines(name, child.stdout, process.stdout));
  if (child.stderr) rls.push(prefixLines(name, child.stderr, process.stderr));

  child.on("exit", () => {
    for (const rl of rls) {
      try {
        rl.close();
      } catch {
        // ignore
      }
    }
  });

  return child;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    if (typeof child.exitCode === "number") {
      throw new Error(`${label} exited before becoming ready (code ${child.exitCode})`);
    }
    if (await fetchOk(url, 2000)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}: ${url}`);
}

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

async function main() {
  runPredev();

  const services = [];

  let tool = null;
  let orch = null;
  let web = null;

  if (mode === "all" || mode === "backend") {
    tool = spawnService("toolserver", nodeCmd, ["scripts/run-toolserver.mjs"]);
    services.push({ name: "toolserver", child: tool });
    await waitForHttpOk({
      url: `http://127.0.0.1:${toolserverPort}/health`,
      label: "toolserver",
      child: tool,
      timeoutMs: 180_000,
    });
  }

  if (mode === "all" || mode === "backend") {
    orch = spawnService("orchestrator", npmCmd, ["-w", "@vidunpack/orchestrator", "run", "dev:serve"]);
    services.push({ name: "orchestrator", child: orch });
    await waitForHttpOk({
      url: `http://127.0.0.1:${orchestratorPort}/api/health`,
      label: "orchestrator",
      child: orch,
      timeoutMs: 120_000,
    });
  }

  if (mode === "all" || mode === "web") {
    web = spawnService("web", npmCmd, ["-w", "@vidunpack/web", "run", "dev"]);
    services.push({ name: "web", child: web });
    await waitForHttpOk({
      url: `http://127.0.0.1:${webPort}/`,
      label: "web",
      child: web,
      timeoutMs: 120_000,
    });
  }

  if (mode !== "web") {
    process.stdout.write(`[vidunpack] Orchestrator health: http://127.0.0.1:${orchestratorPort}/api/health\n`);
    process.stdout.write(`[vidunpack] Toolserver health:   http://127.0.0.1:${toolserverPort}/health\n`);
  }
  if (mode !== "backend") {
    process.stdout.write(`[vidunpack] App URL:            http://127.0.0.1:${webPort}/\n`);
  }

  let shuttingDown = false;
  const shutdown = (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const s of services) killTree(s.child.pid);
    process.exitCode = typeof exitCode === "number" ? exitCode : process.exitCode || 0;
  };

  const onSigint = () => shutdown(0);
  const onSigterm = () => shutdown(0);
  const onSigbreak = () => shutdown(0);
  const onExit = () => shutdown(process.exitCode || 0);

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (process.platform === "win32") process.once("SIGBREAK", onSigbreak);
  process.once("exit", onExit);

  const exitPromises = services.map(
    (s) =>
      new Promise((resolve) => {
        s.child.once("exit", (code, signal) => resolve({ name: s.name, code, signal }));
      }),
  );

  const firstExit = services.length > 0 ? await Promise.race(exitPromises) : null;
  if (!firstExit) return;

  const code = typeof firstExit.code === "number" ? firstExit.code : 1;
  if (!shuttingDown) {
    process.stderr.write(
      `[vidunpack] ${firstExit.name} exited (code ${code}${firstExit.signal ? ` signal ${firstExit.signal}` : ""}); shutting down...\n`,
    );
    shutdown(code);
  }
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[vidunpack] dev failed: ${message}`);
  process.exit(1);
});
