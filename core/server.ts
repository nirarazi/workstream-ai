// core/server.ts — Hono HTTP server exposing the ATC engine API

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createLogger } from "./logger.js";
import { loadConfig, findProjectRoot, resetConfig, type Config } from "./config.js";
import { Database } from "./graph/db.js";
import { ContextGraph } from "./graph/index.js";
import { Classifier } from "./classifier/index.js";
import { DefaultExtractor } from "./graph/extractors/default.js";
import { WorkItemLinker } from "./graph/linker.js";
import { SlackAdapter } from "./adapters/platforms/slack/index.js";
import { JiraAdapter } from "./adapters/tasks/jira/index.js";
import { Pipeline } from "./pipeline.js";
import type { PlatformAdapter } from "./adapters/platforms/interface.js";
import type { TaskAdapter } from "./adapters/tasks/interface.js";

const log = createLogger("server");

// --- Engine state (mutable, shared across routes) ---

export interface EngineState {
  config: Config;
  db: Database;
  graph: ContextGraph;
  classifier: Classifier;
  linker: WorkItemLinker;
  pipeline: Pipeline | null;
  platformAdapter: PlatformAdapter | null;
  taskAdapter: TaskAdapter | null;
  startedAt: Date;
  lastPoll: Date | null;
  processed: number;
}

// --- App factory (testable without starting the server) ---

export function createApp(state: EngineState): Hono {
  const app = new Hono();

  // CORS for Vite dev server
  app.use(
    "/api/*",
    cors({
      origin: "http://localhost:5173",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  // --- GET /api/status ---
  app.get("/api/status", (c) => {
    const uptime = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
    return c.json({
      ok: true,
      uptime,
      pipeline: {
        lastPoll: state.lastPoll?.toISOString() ?? null,
        processed: state.processed,
      },
    });
  });

  // --- GET /api/inbox ---
  app.get("/api/inbox", (c) => {
    const items = state.graph.getActionableItems();
    return c.json({ items });
  });

  // --- GET /api/recent ---
  app.get("/api/recent", (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 20;
    const items = state.graph.getRecentItems(isNaN(limit) ? 20 : limit);
    return c.json({ items });
  });

  // --- GET /api/work-item/:id ---
  app.get("/api/work-item/:id", (c) => {
    const id = c.req.param("id");
    const workItem = state.graph.getWorkItemById(id);
    if (!workItem) {
      return c.json({ error: "Work item not found" }, 404);
    }
    const threads = state.graph.getThreadsForWorkItem(id);
    const events = state.graph.getEventsForWorkItem(id);
    return c.json({ workItem, threads, events });
  });

  // --- GET /api/agents ---
  app.get("/api/agents", (c) => {
    const agents = state.graph.getAllAgents();
    return c.json({ agents });
  });

  // --- POST /api/reply ---
  app.post("/api/reply", async (c) => {
    if (!state.platformAdapter) {
      return c.json({ ok: false, error: "No platform adapter configured" }, 503);
    }

    const body = await c.req.json<{ threadId: string; channelId: string; message: string }>();
    if (!body.threadId || !body.channelId || !body.message) {
      return c.json({ ok: false, error: "Missing required fields: threadId, channelId, message" }, 400);
    }

    try {
      await state.platformAdapter.replyToThread(body.threadId, body.channelId, body.message);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Reply failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- POST /api/action ---
  app.post("/api/action", async (c) => {
    const body = await c.req.json<{
      workItemId: string;
      action: "approve" | "redirect" | "close" | "snooze";
      message?: string;
      snoozeDuration?: number;
    }>();

    if (!body.workItemId || !body.action) {
      return c.json({ ok: false, error: "Missing required fields: workItemId, action" }, 400);
    }

    const validActions = new Set(["approve", "redirect", "close", "snooze"]);
    if (!validActions.has(body.action)) {
      return c.json({ ok: false, error: `Invalid action: ${body.action}` }, 400);
    }

    const workItem = state.graph.getWorkItemById(body.workItemId);
    if (!workItem) {
      return c.json({ ok: false, error: "Work item not found" }, 404);
    }

    try {
      switch (body.action) {
        case "approve":
        case "close":
          state.graph.upsertWorkItem({
            id: body.workItemId,
            source: workItem.source,
            currentAtcStatus: "completed",
          });
          break;

        case "snooze": {
          const durationMs = (body.snoozeDuration ?? 3600) * 1000;
          const snoozedUntil = new Date(Date.now() + durationMs).toISOString();
          state.graph.upsertWorkItem({
            id: body.workItemId,
            source: workItem.source,
            snoozedUntil,
          });
          break;
        }

        case "redirect":
          // Redirect keeps status but acknowledges operator saw it
          state.graph.upsertWorkItem({
            id: body.workItemId,
            source: workItem.source,
            currentAtcStatus: "in_progress",
          });
          break;
      }

      // If there's a message and a platform adapter, post it to the related thread
      if (body.message && state.platformAdapter) {
        const threads = state.graph.getThreadsForWorkItem(body.workItemId);
        if (threads.length > 0) {
          const thread = threads[0];
          await state.platformAdapter.replyToThread(thread.id, thread.channelId, body.message);
        }
      }

      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Action failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- POST /api/setup ---
  app.post("/api/setup", async (c) => {
    const body = await c.req.json<{
      slackToken?: string;
      llmApiKey?: string;
      llmBaseUrl?: string;
      llmModel?: string;
      jiraToken?: string;
      jiraBaseUrl?: string;
    }>();

    try {
      const projectRoot = findProjectRoot();

      // Write local.yaml with non-sensitive config
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { stringify: toYaml } = await import("yaml");

      const configDir = resolve(projectRoot, "config");
      mkdirSync(configDir, { recursive: true });

      const localConfig: Record<string, unknown> = {};

      if (body.llmBaseUrl || body.llmModel) {
        localConfig.classifier = {
          provider: {
            baseUrl: body.llmBaseUrl ?? state.config.classifier.provider.baseUrl,
            model: body.llmModel ?? state.config.classifier.provider.model,
          },
        };
      }

      if (body.jiraBaseUrl) {
        localConfig.jira = {
          enabled: true,
          baseUrl: body.jiraBaseUrl,
        };
      }

      writeFileSync(resolve(configDir, "local.yaml"), toYaml(localConfig), "utf-8");
      log.info("Wrote config/local.yaml");

      // Write .env with sensitive values
      const envLines: string[] = [];
      if (body.slackToken) envLines.push(`ATC_SLACK_TOKEN=${body.slackToken}`);
      if (body.llmApiKey) envLines.push(`ATC_LLM_API_KEY=${body.llmApiKey}`);
      if (body.jiraToken) envLines.push(`ATC_JIRA_TOKEN=${body.jiraToken}`);
      if (body.jiraBaseUrl) envLines.push(`ATC_JIRA_BASE_URL=${body.jiraBaseUrl}`);

      if (envLines.length > 0) {
        writeFileSync(resolve(projectRoot, ".env"), envLines.join("\n") + "\n", "utf-8");
        log.info("Wrote .env");

        // Also set env vars in current process so config reload picks them up
        if (body.slackToken) process.env.ATC_SLACK_TOKEN = body.slackToken;
        if (body.llmApiKey) process.env.ATC_LLM_API_KEY = body.llmApiKey;
        if (body.jiraToken) process.env.ATC_JIRA_TOKEN = body.jiraToken;
        if (body.jiraBaseUrl) process.env.ATC_JIRA_BASE_URL = body.jiraBaseUrl;
      }

      // Reload config
      resetConfig();
      state.config = loadConfig(projectRoot);

      // Stop existing pipeline
      if (state.pipeline) {
        state.pipeline.stop();
        state.pipeline = null;
      }

      // Reconnect adapters
      if (body.slackToken) {
        const slack = new SlackAdapter();
        await slack.connect({ token: body.slackToken });
        state.platformAdapter = slack;
        log.info("Slack adapter reconnected");
      }

      if (body.jiraToken && body.jiraBaseUrl) {
        const jira = new JiraAdapter();
        await jira.connect({ token: body.jiraToken, baseUrl: body.jiraBaseUrl });
        state.taskAdapter = jira;
        log.info("Jira adapter reconnected");
      }

      // Recreate classifier with new config
      state.classifier = Classifier.fromConfig(state.config);

      // Restart pipeline if we have a platform adapter
      if (state.platformAdapter) {
        state.pipeline = new Pipeline(
          state.platformAdapter,
          state.classifier,
          state.graph,
          state.linker,
          state.taskAdapter ?? undefined,
          state.config,
        );
        await state.pipeline.start();
        log.info("Pipeline restarted");
      }

      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Setup failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- GET /api/setup/status ---
  app.get("/api/setup/status", (c) => {
    const slackConfigured = !!process.env.ATC_SLACK_TOKEN;
    const llmConfigured = !!(
      state.config.classifier.provider.apiKey ||
      state.config.classifier.provider.baseUrl.includes("localhost") ||
      state.config.classifier.provider.baseUrl.includes("127.0.0.1")
    );
    const jiraConfigured = !!(state.config.jira.enabled && process.env.ATC_JIRA_TOKEN);

    return c.json({
      configured: slackConfigured && llmConfigured,
      slack: slackConfigured,
      llm: llmConfigured,
      jira: jiraConfigured,
    });
  });

  return app;
}

// --- Bootstrap (when run directly) ---

async function main(): Promise<void> {
  const projectRoot = findProjectRoot();

  // Load .env file if present
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const envPath = resolve(projectRoot, ".env");
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      log.info("Loaded .env file");
    }
  } catch {
    // .env loading is best-effort
  }

  // 1. Load config
  const config = loadConfig(projectRoot);
  log.info("Config loaded");

  // 2. Open/create SQLite database
  const db = new Database("atc.db");

  // 3. Create core components
  const graph = new ContextGraph(db);
  const classifier = Classifier.fromConfig(config, projectRoot);
  const extractor = new DefaultExtractor({
    ticketPatterns: config.extractors.ticketPatterns,
    prPatterns: config.extractors.prPatterns,
  });
  const linker = new WorkItemLinker(graph, [extractor]);

  // Initialize engine state
  const state: EngineState = {
    config,
    db,
    graph,
    classifier,
    linker,
    pipeline: null,
    platformAdapter: null,
    taskAdapter: null,
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
  };

  // 4. If Slack configured, create adapter and connect
  const slackToken = process.env.ATC_SLACK_TOKEN;
  if (slackToken) {
    try {
      const slack = new SlackAdapter();
      await slack.connect({ token: slackToken });
      state.platformAdapter = slack;
      log.info("Slack adapter connected");
    } catch (err) {
      log.error("Failed to connect Slack adapter", err);
    }
  } else {
    log.warn("No ATC_SLACK_TOKEN set — Slack adapter disabled");
  }

  // 5. If Jira configured, create adapter and connect
  if (config.jira.enabled && process.env.ATC_JIRA_TOKEN) {
    try {
      const jira = new JiraAdapter();
      await jira.connect({
        token: process.env.ATC_JIRA_TOKEN,
        baseUrl: process.env.ATC_JIRA_BASE_URL ?? config.jira.baseUrl ?? "",
      });
      state.taskAdapter = jira;
      log.info("Jira adapter connected");
    } catch (err) {
      log.error("Failed to connect Jira adapter", err);
    }
  }

  // 6. Create pipeline if platform adapter is available
  if (state.platformAdapter) {
    state.pipeline = new Pipeline(
      state.platformAdapter,
      state.classifier,
      state.graph,
      state.linker,
      state.taskAdapter ?? undefined,
      state.config,
    );

    // 7. Start pipeline polling
    await state.pipeline.start();
    log.info("Pipeline started");
  } else {
    log.warn("No platform adapter available — pipeline not started (configure via POST /api/setup)");
  }

  // 8. Create and start Hono server
  const app = createApp(state);

  // Static file serving in web mode
  if (process.env.ATC_SERVE_STATIC === "true") {
    const { serveStatic } = await import("@hono/node-server/serve-static");
    app.use("/*", serveStatic({ root: "./dist" }));
    log.info("Serving static files from ./dist/");
  }

  const { serve } = await import("@hono/node-server");
  const host = config.server.host;
  const port = config.server.port;

  serve({ fetch: app.fetch, hostname: host, port }, () => {
    log.info(`ATC engine listening on http://${host}:${port}`);
    if (state.platformAdapter) {
      log.info("Pipeline is polling — inbox is live");
    } else {
      log.info(`No adapters configured — visit http://${host}:${port} to set up`);
    }
  });
}

// Run when executed directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") ||
    process.argv[1].endsWith("server.js"));

if (isDirectRun) {
  main().catch((err) => {
    log.error("Fatal error during startup", err);
    process.exit(1);
  });
}
