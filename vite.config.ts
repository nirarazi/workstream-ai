import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { DEV_UI_DIR, devUiProxy } from "./core/dev-ui";

const host = process.env.TAURI_DEV_HOST;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Point envDir away from project root so Vite doesn't restart
  // when the backend writes .env (credentials). Our .env is for
  // the backend only — Vite doesn't need it.
  envDir: "./src",
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    // The dev server's root is the repo, so block local state and secrets beyond Vite's defaults (.env*, .git):
    // config with the operator's settings, the context graph database, eval data and agent state
    fs: {
      deny: [
        ".env", ".env.*", "*.{crt,pem}", "**/.git/**", // Vite's defaults
        "**/*.db", "**/*.db-*",
        here("config/local.yaml"), `${here("eval-data")}/**`, `${here(".claude")}/**`, `${here(".worktrees")}/**`,
        `${here(".superpowers")}/**`, // local design-session drafts
        `${here(DEV_UI_DIR)}/**`, // the dev server's secret for the engine
      ],
    },
    watch: {
      // Worktrees (agent and git) under this checkout are other checkouts: their changes must not reload this app.
      // Anchored to this folder, so a dev server started inside a worktree still watches its own files.
      ignored: ["**/src-tauri/**", "**/core/**", `${here(".claude")}/**`, `${here(".worktrees")}/**`],
    },
    // The UI reaches the engine only through this proxy in development, the desktop app's dev build included
    proxy: command === "serve" ? { "/api": devUiProxy(here("."), "http://127.0.0.1:9847") } : undefined,
  },
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
