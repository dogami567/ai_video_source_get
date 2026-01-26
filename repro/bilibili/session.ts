import { spawnSync } from "node:child_process";
import process from "node:process";

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function usage(): never {
  // eslint-disable-next-line no-console
  console.error('Usage: npx tsx repro/bilibili/session.ts --url "https://www.bilibili.com/video/BVxxxx"');
  process.exit(2);
}

const url = getArg("--url") || process.argv.find((a) => a.startsWith("http://") || a.startsWith("https://"));
if (!url) usage();

const ytdlp = process.env.YTDLP_PATH || "yt-dlp";
const cookiesFromBrowser =
  getArg("--cookies-from-browser") ||
  (process.env.YTDLP_COOKIES_FROM_BROWSER ? String(process.env.YTDLP_COOKIES_FROM_BROWSER).trim() : "");

if (!cookiesFromBrowser) {
  // eslint-disable-next-line no-console
  console.error("[warn] No cookies source configured. For logged-in access, set YTDLP_COOKIES_FROM_BROWSER=chrome (or edge/firefox).");
}

const args: string[] = ["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings"];
if (cookiesFromBrowser) args.push("--cookies-from-browser", cookiesFromBrowser);
args.push(url);

const res = spawnSync(ytdlp, args, { encoding: "utf8" });
if (res.error) {
  // eslint-disable-next-line no-console
  console.error(`[error] Failed to run ${ytdlp}: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) {
  // eslint-disable-next-line no-console
  console.error(res.stderr || res.stdout || `[error] yt-dlp exited with code ${res.status ?? "unknown"}`);
  process.exit(res.status ?? 1);
}

let info: any;
try {
  info = JSON.parse(String(res.stdout || "").trim());
} catch (e) {
  // eslint-disable-next-line no-console
  console.error("[error] Failed to parse yt-dlp JSON output.");
  // eslint-disable-next-line no-console
  console.error(res.stdout);
  process.exit(1);
}

const summary = {
  extractor: info?.extractor || info?.extractor_key || "unknown",
  id: info?.id || "unknown",
  title: info?.title || "untitled",
  webpage_url: info?.webpage_url || url,
  duration_s: typeof info?.duration === "number" ? info.duration : null,
};

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      ok: true,
      ytdlp,
      cookies_from_browser: cookiesFromBrowser || null,
      summary,
    },
    null,
    2,
  ),
);

