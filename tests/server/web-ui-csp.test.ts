// tests/server/web-ui-csp.test.ts — The UI the engine serves in web mode runs under the desktop app's policy

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { WEB_UI_CSP, useWebUiHeaders } from "../../core/server.js";

const directives = (policy: string) =>
  Object.fromEntries(policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...sources] = d.split(/\s+/);
    return [name, sources.join(" ")];
  }));

function webUi(): Hono {
  const app = new Hono();
  app.get("/api/status", (c) => c.json({ ok: true }));
  useWebUiHeaders(app);
  app.get("/*", (c) => c.html("<!doctype html><title>workstream.ai</title>"));
  return app;
}

describe("web mode's security headers", () => {
  it("serves the UI under the policy, unframeable and never sniffed", async () => {
    const res = await webUi().request("/");
    expect(res.headers.get("content-security-policy")).toBe(WEB_UI_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("covers the UI's files too", async () => {
    const res = await webUi().request("/assets/index-abc123.js");
    expect(res.headers.get("content-security-policy")).toBe(WEB_UI_CSP);
  });

  it("leaves the API's responses alone", async () => {
    const res = await webUi().request("/api/status");
    expect(res.headers.get("content-security-policy")).toBeNull();
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
