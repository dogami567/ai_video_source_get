import { execFileSync } from "node:child_process";

function readPort(envKey, fallback) {
  const raw = String(process.env[envKey] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return "";
  }
}

function uniq(nums) {
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

function findListeningPids(port) {
  if (process.platform === "win32") {
    const out = run("netstat", ["-ano"]);
    const lines = out.split(/\r?\n/);
    const pids = [];
    const re = new RegExp(`\\sTCP\\s+[^\\s]+:${port}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)\\s*$`, "i");
    for (const line of lines) {
      const m = line.match(re);
      if (m?.[1]) pids.push(Number(m[1]));
    }
    return uniq(pids.filter((n) => Number.isFinite(n) && n > 0));
  }

  // macOS/Linux best-effort (optional)
  const out = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pids = out
    .split(/\r?\n/)
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return uniq(pids);
}

function getProcessInfo(pid) {
  if (process.platform === "win32") {
    const cmdline = run("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]).trim();
    const name = run("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`,
    ]).trim();
    return { name, cmdline };
  }

  const name = run("ps", ["-p", String(pid), "-o", "comm="]).trim();
  const cmdline = run("ps", ["-p", String(pid), "-o", "command="]).trim();
  return { name, cmdline };
}

function isSafeToKillForWebPort(info) {
  const name = String(info.name || "").toLowerCase();
  const cmdline = String(info.cmdline || "").toLowerCase();

  // Kill only things that look like our dev server.
  // Be conservative: if we cannot read cmdline, refuse to kill.
  if (!cmdline) return false;

  return (
    cmdline.includes("vite") ||
    cmdline.includes("ai-video-source-get") ||
    cmdline.includes("vidunpack") ||
    (name.includes("node") && cmdline.includes("@vidunpack"))
  );
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function ensurePortFree(port) {
  const before = findListeningPids(port);
  if (before.length === 0) return;

  for (const pid of before) {
    const info = getProcessInfo(pid);
    if (!isSafeToKillForWebPort(info)) {
      const msg = `[predev] Port ${port} is already in use by PID ${pid} (${info.name || "unknown"}). Please stop it or set WEB_PORT to another port.`;
      console.error(msg);
      process.exitCode = 1;
      return;
    }

    console.log(`[predev] Port ${port} in use; stopping PID ${pid} (${info.name || "unknown"})`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  // Wait for release.
  for (let i = 0; i < 20; i += 1) {
    if (findListeningPids(port).length === 0) return;
    await sleep(150);
  }

  // Best-effort hard kill.
  const after = findListeningPids(port);
  for (const pid of after) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
    if (process.platform === "win32") {
      try {
        run("taskkill", ["/PID", String(pid), "/T", "/F"]);
      } catch {
        // ignore
      }
    }
  }

  // Final check.
  for (let i = 0; i < 20; i += 1) {
    if (findListeningPids(port).length === 0) return;
    await sleep(150);
  }

  const still = findListeningPids(port);
  if (still.length > 0) {
    console.error(`[predev] Failed to free port ${port}. PIDs: ${still.join(", ")}. Set WEB_PORT to another port or stop the process.`);
    process.exitCode = 1;
  }
}

const webPort = readPort("WEB_PORT", 6785);
await ensurePortFree(webPort);
