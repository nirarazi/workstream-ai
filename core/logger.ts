// core/logger.ts — Thin console wrapper with component scoping

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  const env = process.env.WORKSTREAM_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) {
    return env as LogLevel;
  }
  return "info";
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(component: string): Logger {
  const minLevel = getMinLevel();
  const minOrder = LEVEL_ORDER[minLevel];

  function log(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < minOrder) return;
    const tag = `[${formatTimestamp()}] [${level.toUpperCase()}] [${component}]`;
    const consoleFn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "debug"
            ? console.debug
            : console.log;
    if (args.length > 0) {
      consoleFn(tag, message, ...args);
    } else {
      consoleFn(tag, message);
    }
  }

  return {
    debug: (message: string, ...args: unknown[]) => log("debug", message, args),
    info: (message: string, ...args: unknown[]) => log("info", message, args),
    warn: (message: string, ...args: unknown[]) => log("warn", message, args),
    error: (message: string, ...args: unknown[]) => log("error", message, args),
  };
}
