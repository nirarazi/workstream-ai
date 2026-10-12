#!/usr/bin/env node
// core/eval/run.ts — Score one or more classifier backends against the labeled eval set
//
// Usage: npm run eval:run -- --backend production,classifier,llm,typesafe [options]
//   production   what the live classifier stored at the time (free baseline)
//   classifier   today's LLM classifier (config/prompts/classify.yaml) on the configured provider
//   llm          DecisionProvider questions answered by an LLM (configured provider unless overridden)
//   typesafe     DecisionProvider questions answered by Jev (TYPESAFE_API_KEY, else via OpenRouter)
// Options:
//   --base-url URL  --model NAME  --api-key-env VAR   override the LLM endpoint (classifier, llm)
//   --typesafe-model NAME                              default jev-latest
//   --concurrency N (default 4)   --limit N   --dataset PATH
// Writes per-item results to eval-data/runs/ for later comparison.

import BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findProjectRoot, loadConfig, type Config } from "../config.js";
import { Classifier } from "../classifier/index.js";
import { classifyWithDecisions, type DecisionClassificationInput } from "../decisions/classification.js";
import { LLMDecisionProvider } from "../decisions/providers/llm.js";
import { TypeSafeDecisionProvider } from "../decisions/providers/typesafe.js";
import type { DecisionProvider } from "../decisions/interface.js";
import type { OperatorIdentityMap } from "../types.js";
import { defaultDatasetPath, labeled, loadDataset, type EvalItem } from "./dataset.js";
import { formatReport, scoreRun, type Prediction } from "./metrics.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Predict = (item: EvalItem) => Promise<Prediction>;

function endpoint(config: Config) {
  const keyEnv = arg("api-key-env");
  return {
    baseUrl: arg("base-url") ?? config.classifier.provider.baseUrl,
    model: arg("model") ?? config.classifier.provider.model,
    apiKey: keyEnv ? process.env[keyEnv] : config.classifier.provider.apiKey,
  };
}

/**
 * The live app gets the operator's identity from the Slack connection. The eval has none, so look up
 * the human whose name matches config.operator.name. Without it the classifier skips the operator profile
 * (and the remit in it) entirely.
 */
function operatorIdentities(config: Config, root: string): OperatorIdentityMap | null {
  const name = config.operator?.name;
  const dbPath = resolve(root, "workstream.db");
  if (!name || !existsSync(dbPath)) return null;
  const db = new BetterSqlite3(dbPath, { readonly: true });
  const row = db.prepare("SELECT platform, platform_user_id FROM agents WHERE is_bot = 0 AND name = ? LIMIT 1").get(name) as
    | { platform: string; platform_user_id: string }
    | undefined;
  db.close();
  return row ? new Map([[row.platform, { userId: row.platform_user_id, userName: name }]]) : null;
}

function decisionInput(item: EvalItem, config: Config): DecisionClassificationInput {
  return {
    message: item.message,
    senderName: item.senderName,
    senderType: item.senderType,
    channelName: item.channelName,
    operatorName: config.operator?.name,
    operatorContext: config.operator?.context,
  };
}

function viaDecisions(provider: DecisionProvider, config: Config): Predict {
  return async (item) => {
    const r = await classifyWithDecisions(provider, decisionInput(item, config));
    return {
      status: r.status,
      confidence: r.confidence,
      targetedAtOperator: r.targetedAtOperator,
      statusProbabilities: r.statusProbabilities,
      latencyMs: r.latencyMs,
      inputTokens: r.usage?.inputTokens,
      outputTokens: r.usage?.outputTokens,
    };
  };
}

function makeBackend(name: string, config: Config, root: string): { label: string; predict: Predict } {
  switch (name) {
    case "production":
      return {
        label: "production (stored live labels)",
        predict: async (item) => ({ ...item.production, latencyMs: 0 }),
      };
    case "classifier": {
      const ep = endpoint(config);
      const classifier = Classifier.fromConfig(
        { ...config, classifier: { ...config.classifier, provider: ep } },
        root,
      );
      const identities = operatorIdentities(config, root);
      if (!identities) process.stderr.write("No operator identity found (set operator.name in config/local.yaml) — remit not applied\n");
      return {
        label: `classifier · ${ep.model}`,
        predict: async (item) => {
          const started = Date.now();
          const c = await classifier.classify(item.message, undefined, identities, {
            senderName: item.senderName,
            senderType: item.senderType,
            channelName: item.channelName,
          });
          // Classifier swallows provider errors and returns noise; count those as errors, not predictions.
          if (c.reason.startsWith("Classification failed") || c.reason === "Provider returned empty result") {
            throw new Error(c.reason);
          }
          return { status: c.status, confidence: c.confidence, targetedAtOperator: c.targetedAtOperator, latencyMs: Date.now() - started };
        },
      };
    }
    case "llm": {
      const ep = endpoint(config);
      return { label: `decisions · llm · ${ep.model}`, predict: viaDecisions(LLMDecisionProvider.fromEndpoint(ep), config) };
    }
    case "typesafe": {
      // Direct TypeSafe key if present, otherwise Jev through OpenRouter on the configured key.
      const direct = process.env.TYPESAFE_API_KEY;
      const viaOpenRouter = !direct && config.classifier.provider.baseUrl.includes("openrouter.ai");
      if (!direct && !viaOpenRouter) {
        throw new Error("typesafe backend needs TYPESAFE_API_KEY, or an OpenRouter classifier provider");
      }
      const model = arg("typesafe-model") ?? (direct ? "jev-latest" : "typesafe/jev-1.13");
      const provider = direct
        ? new TypeSafeDecisionProvider({ apiKey: direct, model })
        : TypeSafeDecisionProvider.viaOpenRouter(config.classifier.provider.apiKey ?? "", model);
      return { label: `decisions · typesafe · ${model}${direct ? "" : " (openrouter)"}`, predict: viaDecisions(provider, config) };
    }
    default:
      throw new Error(`Unknown backend "${name}" (expected production, classifier, llm, typesafe)`);
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main(): Promise<void> {
  const root = findProjectRoot();
  const config = loadConfig();
  const datasetPath = arg("dataset") ?? defaultDatasetPath(root);
  let items = labeled(loadDataset(datasetPath));
  const limit = arg("limit");
  if (limit) items = items.slice(0, Number(limit));
  if (items.length === 0) {
    console.error(`No labeled items in ${datasetPath}. Run eval:sample, then eval:label.`);
    process.exit(1);
  }

  const backends = (arg("backend") ?? "production").split(",").map((b) => b.trim()).filter(Boolean);
  const concurrency = Number(arg("concurrency") ?? "4");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const name of backends) {
    const backend = makeBackend(name, config, root);
    process.stderr.write(`Running ${backend.label} on ${items.length} items…\n`);
    const results = await mapConcurrent(items, concurrency, async (item, i) => {
      let prediction: Prediction;
      try {
        prediction = await backend.predict(item);
      } catch (err) {
        prediction = { status: "noise", confidence: 0, targetedAtOperator: false, latencyMs: 0, error: String(err) };
      }
      if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${items.length}\n`);
      return { id: item.id, truth: item.label, prediction };
    });

    const report = scoreRun(results);
    console.log("\n" + formatReport(backend.label, report) + "\n");

    const outPath = resolve(root, "eval-data", "runs", `${stamp}-${name}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ backend: backend.label, dataset: datasetPath, report, results }, null, 2));
    process.stderr.write(`Saved → ${outPath}\n`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
