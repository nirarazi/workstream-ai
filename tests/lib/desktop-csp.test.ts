// tests/lib/desktop-csp.test.ts — The desktop app's webview runs under a strict content security policy

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
  app: { security: Record<string, unknown> & { csp?: string | null } };
};
const csp = conf.app.security.csp ?? "";
const entries = csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...sources] = d.split(/\s+/);
  return [name, sources] as const;
});

describe("desktop webview CSP", () => {
  it("names each directive once (a browser enforces the first of two)", () => {
    const names = entries.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is exactly this policy: loosening any directive must be a deliberate change here", () => {
    expect(Object.fromEntries(entries)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      // React's style attributes. An inline <style> in the page would make Tauri add a nonce, and browsers then ignore 'unsafe-inline'
      "style-src": ["'self'", "'unsafe-inline'"],
      // Avatars come from the engine
      "img-src": ["'self'", "data:", "http://127.0.0.1:9847"],
      "font-src": ["'self'", "data:"],
      // The shell's IPC (macOS/Linux, then Windows) and the local engine
      "connect-src": ["'self'", "ipc:", "http://ipc.localhost", "http://127.0.0.1:9847"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "frame-src": ["'none'"],
      "form-action": ["'none'"],
    });
  });

  it("isn't switched off or rewritten by other security settings", () => {
    expect(Object.keys(conf.app.security).sort()).toEqual(["csp"]);
  });

  it("has a page without inline scripts or styles, which would change how Tauri applies it", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).not.toMatch(/<style[\s>]/i);
    // Every script is loaded from a file
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) expect(tag).toMatch(/\ssrc=/);
  });
});
