// tests/lib/external-links.test.ts — Only web and email links are opened outside the app

import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createElement } from "react";

const shellOpen = vi.fn(async (_url: string) => {});
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

import { openableUrl, openExternalUrl } from "../../src/lib/api.js";
import SlackMessage from "../../src/messaging/slack/SlackMessage.js";

/** Runs the test as the desktop app (Tauri marks its webview with this global) */
function inDesktopApp(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  cleanup();
  shellOpen.mockReset();
  vi.restoreAllMocks();
});

const ALLOWED = [
  "https://example.slack.com/archives/C0FLEETOPS/p1700000000000100",
  "http://localhost:8080/browse/OPS-101",
  "HTTPS://Example.COM/a",
  "https://bücher.example/x y",
  "  https://example.com/a b",
  "mailto:dana@example.com",
];

const REFUSED = [
  "file:///etc/hosts",
  "javascript:alert(1)",
  "  JavaScript:alert(1)",
  "smb://fileserver/share",
  "vscode://file/tmp/x",
  "data:text/html,hi",
  "tel:+15555550100",
  "mailto:",
  "mailto:dana@example.com x",
  "mailto: dana@example.com",
  "/relative/path",
  "",
];

describe("openableUrl", () => {
  it("allows web and email links, as their parsed form", () => {
    expect(openableUrl("http://localhost:8080/browse/OPS-101")).toBe("http://localhost:8080/browse/OPS-101");
    expect(openableUrl("  https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(openableUrl("HTTPS://Example.COM/a")).toBe("https://example.com/a");
    expect(openableUrl("https://bücher.example/x")).toBe("https://xn--bcher-kva.example/x");
    expect(openableUrl("mailto:dana@example.com")).toBe("mailto:dana@example.com");
  });

  it("keeps only the address of an email link", () => {
    expect(openableUrl("mailto:dana@example.com?attach=/etc/hosts&subject=hi")).toBe("mailto:dana@example.com");
  });

  it("refuses other schemes and anything that isn't a URL", () => {
    for (const url of REFUSED) expect(openableUrl(url), url).toBeNull();
  });

  it("agrees with the desktop app's own check, so nothing it allows is refused there", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { plugins: { shell: { open: string } } };
    // The shell plugin anchors the pattern at both ends
    const desktop = new RegExp(`^${conf.plugins.shell.open}$`);
    for (const url of ALLOWED) expect(openableUrl(url), url).toMatch(desktop);
    for (const url of REFUSED) expect(desktop.test(url.trim()), url).toBe(false);
  });
});

describe("openExternalUrl", () => {
  it("opens a web link", async () => {
    inDesktopApp();
    await openExternalUrl("https://example.com/pr/42");
    expect(shellOpen).toHaveBeenCalledWith("https://example.com/pr/42");
  });

  it("opens nothing, through the shell or the browser, for another scheme", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    for (const desktop of [true, false]) {
      if (desktop) inDesktopApp();
      await openExternalUrl("file:///Applications/Calculator.app");
    }
    expect(shellOpen).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("in the desktop app, leaves a link the shell refuses unopened", async () => {
    inDesktopApp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    shellOpen.mockRejectedValueOnce(new Error("refused by the shell's scope"));
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await openExternalUrl("https://example.com/a");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("in a browser, opens the same parsed link in a new tab", async () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await openExternalUrl("  https://example.com/a b");
    expect(shellOpen).not.toHaveBeenCalled();
    expect(windowOpen).toHaveBeenCalledWith("https://example.com/a%20b", "_blank", "noreferrer");
  });
});

describe("links in Slack messages", () => {
  it("shows a link that wouldn't open as plain text", () => {
    render(createElement(SlackMessage, { text: "see <file:///etc/hosts|the hosts file> or <https://example.com|the docs>" }));
    expect(screen.queryByRole("button", { name: "the hosts file" })).toBeNull();
    expect(screen.getByText("the hosts file")).toBeTruthy();
    expect(screen.getByRole("button", { name: "the docs" })).toBeTruthy();
  });

  it("shows where a link really goes, whatever its label says", () => {
    render(createElement(SlackMessage, { text: "<https://phish.example/x|https://github.com/example/repo/pull/42>" }));
    expect(screen.getByRole("button").getAttribute("title")).toBe("https://phish.example/x");
  });

  it("keeps email addresses clickable", () => {
    render(createElement(SlackMessage, { text: "ask <mailto:dana@example.com|dana@example.com>" }));
    expect(screen.getByRole("button", { name: "dana@example.com" })).toBeTruthy();
  });
});
