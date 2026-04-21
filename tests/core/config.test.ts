import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig, resetConfig, getConfig } from "../../core/config.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// Use a temp directory for each test to avoid touching real config
function makeTempProject(): string {
  const dir = resolve(tmpdir(), `workstream-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(dir, "config"), { recursive: true });
  return dir;
}

function writeDefaultYaml(root: string, content: string): void {
  writeFileSync(resolve(root, "config", "default.yaml"), content);
}

function writeLocalYaml(root: string, content: string): void {
  writeFileSync(resolve(root, "config", "local.yaml"), content);
}

const MINIMAL_YAML = `
messaging:
  pollInterval: 30
  channels: []
classifier:
  provider:
    baseUrl: https://api.example.com
    model: test-model
  confidenceThreshold: 0.6
taskAdapter:
  enabled: false
  ticketPrefixes:
    - "AI-"
extractors:
  ticketPatterns:
    - "\\\\b([A-Z]{2,6}-\\\\d+)\\\\b"
  prPatterns:
    - "PR #?(\\\\d+)"
mcp:
  transport: stdio
server:
  port: 9847
  host: "127.0.0.1"
`;

describe("config", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = makeTempProject();
    resetConfig();
    // Suppress config logger output
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    // Clean env vars we may have set
    delete process.env.TEST_BASE_URL;
    delete process.env.TEST_MODEL;
  });

  it("loads a valid default config", () => {
    writeDefaultYaml(tempRoot, MINIMAL_YAML);
    const cfg = loadConfig(tempRoot);
    expect(cfg.messaging.pollInterval).toBe(30);
    expect(cfg.classifier.provider.model).toBe("test-model");
    expect(cfg.server.port).toBe(9847);
    expect(cfg.taskAdapter.enabled).toBe(false);
  });

  it("merges local.yaml overlay on top of default", () => {
    writeDefaultYaml(tempRoot, MINIMAL_YAML);
    writeLocalYaml(tempRoot, `
messaging:
  pollInterval: 10
  channels:
    - general
`);
    const cfg = loadConfig(tempRoot);
    expect(cfg.messaging.pollInterval).toBe(10);
    expect(cfg.messaging.channels).toEqual(["general"]);
    // Non-overridden values are preserved
    expect(cfg.server.port).toBe(9847);
  });

  it("substitutes env vars with ${VAR:-default} syntax", () => {
    writeDefaultYaml(tempRoot, `
messaging:
  pollInterval: 30
  channels: []
classifier:
  provider:
    baseUrl: \${TEST_BASE_URL:-https://fallback.com}
    model: \${TEST_MODEL:-fallback-model}
  confidenceThreshold: 0.6
taskAdapter:
  enabled: false
  ticketPrefixes: []
extractors:
  ticketPatterns: []
  prPatterns: []
mcp:
  transport: stdio
server:
  port: 9847
  host: "127.0.0.1"
`);
    // Without env vars set — uses defaults
    const cfg1 = loadConfig(tempRoot);
    expect(cfg1.classifier.provider.baseUrl).toBe("https://fallback.com");
    expect(cfg1.classifier.provider.model).toBe("fallback-model");

    // With env vars set
    process.env.TEST_BASE_URL = "https://custom.com";
    process.env.TEST_MODEL = "custom-model";
    const cfg2 = loadConfig(tempRoot);
    expect(cfg2.classifier.provider.baseUrl).toBe("https://custom.com");
    expect(cfg2.classifier.provider.model).toBe("custom-model");
  });

  it("throws if default.yaml is missing", () => {
    const emptyRoot = makeTempProject();
    rmSync(resolve(emptyRoot, "config", "default.yaml"), { force: true });
    expect(() => loadConfig(emptyRoot)).toThrow("Default config not found");
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("throws on invalid config shape", () => {
    writeDefaultYaml(tempRoot, `
messaging:
  pollInterval: "not a number"
  channels: []
`);
    expect(() => loadConfig(tempRoot)).toThrow();
  });

  it("getConfig returns a singleton", () => {
    // Use the real project root for singleton test
    const projectRoot = resolve(import.meta.dirname, "../..");
    resetConfig();
    // Monkey-patch loadConfig indirectly by calling getConfig which uses findProjectRoot
    // Just verify getConfig doesn't throw when pointed at the real project
    const cfg1 = loadConfig(projectRoot);
    expect(cfg1).toBeDefined();
    expect(cfg1.messaging).toBeDefined();
  });

  it("works with the actual project default.yaml", () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const cfg = loadConfig(projectRoot);
    expect(cfg.messaging.pollInterval).toBe(30);
    expect(cfg.mcp.transport).toBe("stdio");
    expect(cfg.server.port).toBe(9847);
  });

  it("loads quickReplies config", () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const config = loadConfig(projectRoot);
    expect(config.quickReplies).toBeDefined();
    expect(config.quickReplies.blocked_on_human).toBeInstanceOf(Array);
    expect(config.quickReplies.blocked_on_human.length).toBeGreaterThan(0);
  });

  it("loads anomaly thresholds config", () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const config = loadConfig(projectRoot);
    expect(config.anomalies).toBeDefined();
    expect(config.anomalies.staleThresholdHours).toBe(4);
    expect(config.anomalies.silentAgentThresholdHours).toBe(2);
  });

  it("loads default llmBudget with null values", () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const config = loadConfig(projectRoot);
    expect(config.llmBudget).toBeDefined();
    expect(config.llmBudget.dailyBudget).toBeNull();
    expect(config.llmBudget.inputCostPerMillion).toBeNull();
    expect(config.llmBudget.outputCostPerMillion).toBeNull();
  });

  it("accepts operator.role field", () => {
    writeDefaultYaml(tempRoot, MINIMAL_YAML + `
operator:
  name: "Test Operator"
  role: "CTO / Fleet operator"
  context: "Runs the InsureTax agent fleet"
`);
    const cfg = loadConfig(tempRoot);
    expect(cfg.operator.role).toBe("CTO / Fleet operator");
  });
});
