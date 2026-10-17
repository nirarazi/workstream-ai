// core/dev-ui.ts — Proof that a request came through this checkout's own Vite dev server

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

/** The Vite dev server's origins. The engine trusts them only on requests that carry the dev server's secret. */
export const DEV_UI_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** Header the dev server's /api proxy adds to every request it forwards */
export const DEV_UI_HEADER = "x-workstream-dev-ui";

/** Gitignored, and denied to the dev server's own file serving */
export const DEV_UI_DIR = ".workstream-dev";

const secretPath = (projectRoot: string) => join(projectRoot, DEV_UI_DIR, "ui-secret");

/** A new secret for this dev server run, readable only by this user */
export function createDevUiSecret(projectRoot: string): string {
  const secret = randomBytes(32).toString("hex");
  mkdirSync(join(projectRoot, DEV_UI_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(secretPath(projectRoot), secret, { mode: 0o600 });
  chmodSync(secretPath(projectRoot), 0o600);
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
 * The dev server's /api proxy to the engine: it forwards only requests from this machine (the dev server may
 * listen on the network for TAURI_DEV_HOST), and adds the secret, which pages from anywhere else can't know.
 */
export function devUiProxy(projectRoot: string, target: string) {
  const secret = createDevUiSecret(projectRoot);
  return {
    target,
    headers: { [DEV_UI_HEADER]: secret },
    bypass: (req: IncomingMessage) => (LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "") ? undefined : false),
  };
}
