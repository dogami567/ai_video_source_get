import path from "node:path";
import process from "node:process";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const webPort = Number(process.env.WEB_PORT || 6785);
const orchestratorPort = Number(process.env.ORCHESTRATOR_PORT || 6790);
const toolserverPort = Number(process.env.TOOLSERVER_PORT || 6791);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${orchestratorPort}`,
        changeOrigin: true,
      },
      "/tool": {
        target: `http://127.0.0.1:${toolserverPort}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tool/, ""),
      },
    },
  },
});
