import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const exeName = process.platform === "win32" ? "vidunpack-toolserver.exe" : "vidunpack-toolserver";
const binPath = path.join(repoRoot, "target", "debug", exeName);

function spawnOnce(cmd, args) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
    child.on("exit", (code, signal) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("error", (err) => reject(err));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveCargoCmd() {
  const env = String(process.env.CARGO || "").trim();
  if (env) return env;

  if (process.platform === "win32") {
    const home = String(process.env.USERPROFILE || "").trim();
    if (home) {
      const p = path.join(home, ".cargo", "bin", "cargo.exe");
      if (existsSync(p)) return p;
    }
  }

  return "cargo";
}

function maxMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function maxMtimeInDir(dirPath) {
  let max = 0;
  let entries = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      max = Math.max(max, maxMtimeInDir(p));
      continue;
    }
    if (!ent.isFile()) continue;
    max = Math.max(max, maxMtimeMs(p));
  }
  return max;
}

function toolserverSourceMtimeMs() {
  const crateDir = path.join(repoRoot, "crates", "toolserver");
  const srcDir = path.join(crateDir, "src");
  const candidates = [
    path.join(repoRoot, "Cargo.toml"),
    path.join(repoRoot, "Cargo.lock"),
    path.join(crateDir, "Cargo.toml"),
  ];
  let max = 0;
  for (const p of candidates) max = Math.max(max, maxMtimeMs(p));
  max = Math.max(max, maxMtimeInDir(srcDir));
  return max;
}

async function maybeRebuildBinary() {
  if (!existsSync(binPath)) return;

  const binMtime = maxMtimeMs(binPath);
  const srcMtime = toolserverSourceMtimeMs();
  if (!srcMtime || srcMtime <= binMtime + 1) return;

  const cargo = resolveCargoCmd();
  console.log(`[toolserver] Detected newer Rust source; rebuilding with cargo...`);
  try {
    const r = await spawnOnce(cargo, ["build", "-p", "vidunpack-toolserver"]);
    if (r.code !== 0) {
      console.error(`[toolserver] cargo build failed with code ${r.code}; continuing with existing binary`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[toolserver] cargo build failed to start: ${message}; continuing with existing binary`);
  }
}

async function main() {
  await maybeRebuildBinary();

  const hasBin = existsSync(binPath);
  if (!hasBin) {
    console.log("[toolserver] No prebuilt binary found; falling back to cargo run");
    const cargo = resolveCargoCmd();
    const r = await spawnOnce(cargo, ["run", "-p", "vidunpack-toolserver"]);
    process.exit(r.code);
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    console.log(`[toolserver] Running ${binPath}`);
    const r = await spawnOnce(binPath, []);
    if (r.code === 0) process.exit(0);

    const quickFail = r.durationMs < 2500;
    console.error(
      `[toolserver] Prebuilt binary exited with code ${r.code}${r.signal ? ` (signal ${r.signal})` : ""} after ${r.durationMs}ms`,
    );

    if (!quickFail) process.exit(r.code);

    if (attempt < maxRetries) {
      const backoff = 250 * attempt;
      console.log(`[toolserver] Quick exit; retrying prebuilt binary in ${backoff}ms...`);
      await sleep(backoff);
      continue;
    }

    console.log("[toolserver] Falling back to cargo run (if available)...");
    const cargo = resolveCargoCmd();
    try {
      const rr = await spawnOnce(cargo, ["run", "-p", "vidunpack-toolserver"]);
      process.exit(rr.code);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[toolserver] cargo run fallback failed: ${message}`);
      console.error("[toolserver] Install Rust (cargo) or remove target/debug binary to force rebuild.");
      process.exit(r.code || 1);
    }
  }
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[toolserver] failed to start: ${message}`);
  process.exit(1);
});
