import path from "node:path";
import process from "node:process";

import "dotenv/config";
import dotenv from "dotenv";
import express from "express";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "orchestrator" });
});

const port = Number(process.env.ORCHESTRATOR_PORT || 6790);
app.listen(port, "127.0.0.1", () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${port}`);
});

