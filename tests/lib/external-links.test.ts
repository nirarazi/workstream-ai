// tests/lib/external-links.test.ts — Only web links are opened outside the app

import { describe, it, expect, vi, afterEach } from "vitest";

const shellOpen = vi.fn(async (_url: string) => {});
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

import { openableUrl, openExternalUrl } from "../../src/lib/api.js";

afterEach(() => {
  shellOpen.mockClear();
  vi.restoreAllMocks();
});

describe("openableUrl", () => {
  it("allows http and https links", () => {
    expect(openableUrl("https://example.slack.com/archives/C0FLEETOPS/p1700000000000100")).toBe("https://example.slack.com/archives/C0FLEETOPS/p1700000000000100");
    expect(openableUrl("http://localhost:8080/browse/OPS-101")).toBe("http://localhost:8080/browse/OPS-101");
  });

  it("returns the parsed form, so what was checked is what opens", () => {
    expect(openableUrl("  https://example.com/a b")).toBe("https://example.com/a%20b");
  });

  it("refuses other schemes and anything that isn't a URL", () => {
    for (const url of [
      "file:///etc/hosts",
      "javascript:alert(1)",
      "smb://fileserver/share",
      "vscode://file/tmp/x",
      "data:text/html,hi",
      "mailto:dana@example.com",
      "  JavaScript:alert(1)",
      "/relative/path",
      "",
    ]) {
      expect(openableUrl(url), url).toBeNull();
    }
  });
});

describe("openExternalUrl", () => {
  it("opens a web link", async () => {
    await openExternalUrl("https://example.com/pr/42");
    expect(shellOpen).toHaveBeenCalledWith("https://example.com/pr/42");
  });

  it("opens nothing, through the shell or the browser, for another scheme", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await openExternalUrl("file:///Applications/Calculator.app");
    expect(shellOpen).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });
});
