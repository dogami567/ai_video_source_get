import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
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

async function main() {
  const hasBin = existsSync(binPath);
  if (!hasBin) {
    console.log("[toolserver] No prebuilt binary found; falling back to cargo run");
    const r = await spawnOnce("cargo", ["run", "-p", "vidunpack-toolserver"]);
    process.exit(r.code);
  }

  console.log(`[toolserver] Running ${binPath}`);
  const r = await spawnOnce(binPath, []);
  if (r.code === 0) process.exit(0);

  const quickFail = r.durationMs < 2000;
  console.error(
    `[toolserver] Prebuilt binary exited with code ${r.code}${r.signal ? ` (signal ${r.signal})` : ""} after ${r.durationMs}ms`,
  );

  if (!quickFail) process.exit(r.code);

  console.log("[toolserver] Falling back to cargo run (if available)...");
  try {
    const rr = await spawnOnce("cargo", ["run", "-p", "vidunpack-toolserver"]);
    process.exit(rr.code);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[toolserver] cargo run fallback failed: ${message}`);
    console.error("[toolserver] Install Rust (cargo) or remove target/debug binary to force rebuild.");
    process.exit(r.code || 1);
  }
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[toolserver] failed to start: ${message}`);
  process.exit(1);
});
