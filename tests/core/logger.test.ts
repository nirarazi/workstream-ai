import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../core/logger.js";

describe("logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WORKSTREAM_LOG_LEVEL;
  });

  it("creates a logger with all four methods", () => {
    const log = createLogger("test");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("formats log lines with timestamp, level, and component", () => {
    const log = createLogger("mycomp");
    log.info("hello world");
    expect(console.log).toHaveBeenCalledTimes(1);
    const arg = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(arg).toMatch(/^\[.*\] \[INFO\] \[mycomp\]$/);
  });

  it("passes extra args to console", () => {
    const log = createLogger("test");
    log.info("hello", { extra: true });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[INFO] [test]"),
      "hello",
      { extra: true },
    );
  });

  it("uses console.error for error level", () => {
    const log = createLogger("test");
    log.error("bad thing");
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("uses console.warn for warn level", () => {
    const log = createLogger("test");
    log.warn("careful");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("respects WORKSTREAM_LOG_LEVEL=error — suppresses info and warn", () => {
    process.env.WORKSTREAM_LOG_LEVEL = "error";
    // createLogger reads env at creation time
    const log = createLogger("test");
    log.info("should not appear");
    log.warn("should not appear");
    log.error("should appear");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("respects WORKSTREAM_LOG_LEVEL=debug — shows everything", () => {
    process.env.WORKSTREAM_LOG_LEVEL = "debug";
    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(console.debug).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("defaults to info level — suppresses debug", () => {
    const log = createLogger("test");
    log.debug("hidden");
    log.info("visible");
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledTimes(1);
  });
});
