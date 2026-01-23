import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const exeName = process.platform === "win32" ? "vidunpack-toolserver.exe" : "vidunpack-toolserver";
const binPath = path.join(repoRoot, "target", "debug", exeName);

function run(cmd, args) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error(`[toolserver] failed to start: ${err?.message || String(err)}`);
    process.exit(1);
  });
}

if (existsSync(binPath)) {
  console.log(`[toolserver] Running ${binPath}`);
  run(binPath, []);
} else {
  console.log("[toolserver] No prebuilt binary found; falling back to cargo run");
  run("cargo", ["run", "-p", "vidunpack-toolserver"]);
}

