// tests/server/web-ui-csp.test.ts — The UI the engine serves in web mode runs under the desktop app's policy

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { WEB_UI_CSP, serveWebUi } from "../../core/server.js";

const directives = (policy: string) =>
  Object.fromEntries(policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...sources] = d.split(/\s+/);
    return [name, sources.join(" ")];
  }));

let dist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "web-ui-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>workstream.ai</title>");
  writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1)");
});

afterAll(() => rmSync(dist, { recursive: true, force: true }));

/** The engine's app as web mode builds it: API routes first, then the UI's files */
function webUi(): Hono {
  const app = new Hono();
  app.get("/api/status", (c) => c.json({ ok: true }));
  serveWebUi(app, dist);
  return app;
}

describe("web mode's security headers", () => {
  it("serves the UI under the policy, unframeable and never sniffed", async () => {
    const res = await webUi().request("/");
    expect(await res.text()).toContain("workstream.ai");
    expect(res.headers.get("content-security-policy")).toBe(WEB_UI_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("covers the UI's files and missing pages too", async () => {
    const asset = await webUi().request("/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-security-policy")).toBe(WEB_UI_CSP);
    const missing = await webUi().request("/missing");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toBe(WEB_UI_CSP);
  });

  it("leaves the API's responses alone", async () => {
    for (const path of ["/api/status", "/api/unknown"]) {
      const res = await webUi().request(path);
      expect(res.headers.get("content-security-policy"), path).toBeNull();
    }
  });

  it("is the desktop app's policy, except that it talks to this engine and can't be framed", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { app: { security: { csp: string } } };
    const desktop = directives(conf.app.security.csp);
    const web = directives(WEB_UI_CSP);
    expect(web["connect-src"]).toBe("'self'");
    expect(web["frame-ancestors"]).toBe("'none'");
    const { "connect-src": _d, ...desktopRest } = desktop;
    const { "connect-src": _w, "frame-ancestors": _f, ...webRest } = web;
    expect(webRest).toEqual(desktopRest);
  });
});
