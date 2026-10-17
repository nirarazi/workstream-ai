// core/dev-ui.ts — Proof that a request came from the UI through this checkout's own Vite dev server

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";

/** The Vite dev server's origins. The engine trusts them only on requests that carry the dev server's secret. */
export const DEV_UI_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** Header the dev server's /api proxy adds to the UI's requests */
export const DEV_UI_HEADER = "x-workstream-dev-ui";

/** Gitignored, and denied to the dev server's own file serving */
export const DEV_UI_DIR = ".workstream-dev";

const secretPath = (projectRoot: string) => join(projectRoot, DEV_UI_DIR, "ui-secret");

/** A new secret for this dev server run, readable only by this user, never written through a link */
export function createDevUiSecret(projectRoot: string): string {
  const dir = join(projectRoot, DEV_UI_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`${dir} must be a directory of this user's`);
  }
  chmodSync(dir, 0o700);
  const secret = randomBytes(32).toString("hex");
  try {
    unlinkSync(secretPath(projectRoot));
  } catch {
    // None yet
  }
  writeFileSync(secretPath(projectRoot), secret, { mode: 0o600, flag: "wx" });
  return secret;
}

/** Whether `presented` is the running dev server's secret. Read on each call, so a restarted dev server's new one counts. */
export function isDevUiSecret(projectRoot: string, presented: string | undefined): boolean {
  if (!presented) return false;
  let secret: string;
  try {
    secret = readFileSync(secretPath(projectRoot), "utf8").trim();
  } catch {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whether the proxy may forward a request: from this machine (the dev server may listen on the network for
 * TAURI_DEV_HOST, so Tauri's mobile dev builds can't reach the engine), and from the dev server's own pages, as other
 * pages on this machine could otherwise read and write through it with the secret added.
 */
export function isOwnUiRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/**
 * The dev server's /api proxy to the engine, and the plugin that makes its secret. The secret is written once the
 * dev server is listening, so a run that fails to start (the port is taken) or a preview leaves the live one alone.
 */
export function devUiServer(projectRoot: string, target: string): { plugin: Plugin; proxy: Record<string, unknown> } {
  let secret = "";
  const plugin: Plugin = {
    name: "workstream-dev-ui",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        secret = createDevUiSecret(projectRoot);
      });
    },
  };
  const proxy = {
    target,
    bypass: (req: IncomingMessage) => (isOwnUiRequest(req) ? undefined : false),
    configure: (proxyServer: { on: (event: "proxyReq", listener: (proxyReq: { setHeader: (name: string, value: string) => void }) => void) => void }) => {
      proxyServer.on("proxyReq", (proxyReq) => {
        if (secret) proxyReq.setHeader(DEV_UI_HEADER, secret);
      });
    },
  };
  return { plugin, proxy };
}
