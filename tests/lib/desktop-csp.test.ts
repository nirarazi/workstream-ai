// tests/lib/desktop-csp.test.ts — The desktop app's webview runs under a strict content security policy

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { app: { security: { csp: string | null } } };

/** The policy as directive → sources */
function directives(csp: string): Map<string, string[]> {
  return new Map(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...sources] = d.split(/\s+/);
    return [name, sources];
  }));
}

describe("desktop webview CSP", () => {
  const policy = directives(conf.app.security.csp ?? "");

  it("is set", () => {
    expect(conf.app.security.csp).toBeTruthy();
  });

  it("runs only the app's own scripts", () => {
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
  });

  it("talks only to the app, its shell and the local engine", () => {
    for (const source of policy.get("connect-src") ?? []) {
      expect(["'self'", "ipc:", "http://ipc.localhost", "http://127.0.0.1:9847"], source).toContain(source);
    }
  });

  it("allows no plugins, frames, form posts or base changes", () => {
    for (const name of ["object-src", "frame-src", "base-uri", "form-action"]) {
      expect(policy.get(name), name).toEqual(["'none'"]);
    }
  });
});
