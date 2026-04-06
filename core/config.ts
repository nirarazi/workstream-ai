// core/config.ts — YAML config loader with env var substitution and zod validation

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createLogger } from "./logger.js";

const log = createLogger("config");

// --- Schema ---

const RateLimitSchema = z.object({
  maxPerMinute: z.number(),
});

const ConfigSchema = z.object({
  slack: z.object({
    pollInterval: z.number(),
    channels: z.array(z.string()),
  }),
  classifier: z.object({
    provider: z.object({
      baseUrl: z.string(),
      model: z.string(),
      apiKey: z.string().optional(),
    }),
    confidenceThreshold: z.number(),
  }),
  jira: z.object({
    enabled: z.boolean(),
    baseUrl: z.string().optional(),
    token: z.string().optional(),
    ticketPrefixes: z.array(z.string()),
    defaultProject: z.string().optional(),
  }),
  extractors: z.object({
    ticketPatterns: z.array(z.string()),
    prPatterns: z.array(z.string()),
  }),
  rateLimits: z.object({
    llm: RateLimitSchema,
    slack: RateLimitSchema,
    jira: RateLimitSchema,
  }).optional(),
  lookback: z.object({
    initialDays: z.number(),
    maxThreadsPerPoll: z.number(),
  }).optional(),
  mcp: z.object({
    transport: z.string(),
  }),
  server: z.object({
    port: z.number(),
    host: z.string(),
  }),
  quickReplies: z.record(z.string(), z.array(z.string())).optional().default({
    blocked_on_human: [
      "Approved, proceed",
      "Hold — waiting for my review",
      "Re-do with the following constraint:",
    ],
    needs_decision: [
      "Go with option A",
      "Go with option B",
      "Need more info before deciding",
    ],
  }),
  anomalies: z.object({
    staleThresholdHours: z.number(),
    silentAgentThresholdHours: z.number(),
  }).optional().default({
    staleThresholdHours: 4,
    silentAgentThresholdHours: 2,
  }),
  sidekick: z.object({
    enabled: z.boolean(),
    maxToolCalls: z.number(),
    maxHistoryTurns: z.number(),
  }).optional().default({
    enabled: true,
    maxToolCalls: 5,
    maxHistoryTurns: 10,
  }),
  llmBudget: z.object({
    dailyBudget: z.number().nullable(),
    inputCostPerMillion: z.number().nullable(),
    outputCostPerMillion: z.number().nullable(),
  }).optional().default({
    dailyBudget: null,
    inputCostPerMillion: null,
    outputCostPerMillion: null,
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

// --- Env var substitution ---

const ENV_VAR_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

function substituteEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_VAR_PATTERN, (_match, varName: string, defaultValue?: string) => {
      const envVal = process.env[varName];
      if (envVal !== undefined && envVal !== "") return envVal;
      if (defaultValue !== undefined) return defaultValue;
      return "";
    });
  }
  if (Array.isArray(value)) {
    return value.map(substituteEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteEnvVars(v);
    }
    return result;
  }
  return value;
}

// --- Deep merge ---

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(overlay)) {
    const baseVal = base[key];
    const overVal = overlay[key];
    if (
      baseVal !== null &&
      overVal !== null &&
      typeof baseVal === "object" &&
      typeof overVal === "object" &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>);
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

// --- Loader ---

export function findProjectRoot(): string {
  // Walk up from this file's directory to find config/default.yaml
  let dir = resolve(import.meta.dirname ?? process.cwd());
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "config", "default.yaml"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to cwd
  return process.cwd();
}

export function loadConfig(projectRoot?: string): Config {
  const root = projectRoot ?? findProjectRoot();
  const defaultPath = resolve(root, "config", "default.yaml");
  const localPath = resolve(root, "config", "local.yaml");

  if (!existsSync(defaultPath)) {
    throw new Error(`Default config not found: ${defaultPath}`);
  }

  const defaultRaw = parseYaml(readFileSync(defaultPath, "utf-8")) as Record<string, unknown>;
  log.debug("Loaded default config", defaultPath);

  let merged = defaultRaw;

  if (existsSync(localPath)) {
    const localRaw = parseYaml(readFileSync(localPath, "utf-8")) as Record<string, unknown>;
    merged = deepMerge(defaultRaw, localRaw);
    log.debug("Merged local config overlay", localPath);
  }

  const substituted = substituteEnvVars(merged) as Record<string, unknown>;
  const parsed = ConfigSchema.parse(substituted);
  log.info("Config loaded successfully");
  return parsed;
}

// --- Singleton ---

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/** Reset singleton — useful for testing */
export function resetConfig(): void {
  _config = null;
}
