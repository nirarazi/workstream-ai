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
import { createRateLimiter, type RateLimiter } from "./rate-limiter.js";
import { Summarizer } from "./summarizer/index.js";
import { detectAnomalies, type FleetItemInput } from "./graph/anomalies.js";

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

  // --- GET /api/work-item/:id/context ---
  app.get("/api/work-item/:id/context", async (c) => {
    const id = c.req.param("id");
    const workItem = state.graph.getWorkItemById(id);
    if (!workItem) {
      return c.json({ error: "Work item not found" }, 404);
    }

    const threads = state.graph.getThreadsForWorkItem(id);
    const events = state.graph.getEventsForWorkItem(id);
    const enrichments = state.graph.getEnrichmentsForWorkItem(id);

    // Determine quick replies based on work item status
    const quickReplies: string[] =
      (state.config as any).quickReplies?.[workItem.currentAtcStatus ?? ""] ?? [];

    // Summary: check cache, return cached or null
    let summary: string | null = null;
    const cached = state.graph.getSummary(id);
    const latestEvent = events.length > 0 ? events[events.length - 1] : null;

    if (cached && latestEvent && cached.latestEventId === latestEvent.id) {
      summary = cached.summaryText;
    }

    return c.json({
      workItem,
      threads,
      events,
      enrichments,
      quickReplies,
      summary,
    });
  });

  // --- POST /api/work-item/:id/summarize ---
  app.post("/api/work-item/:id/summarize", async (c) => {
    const id = c.req.param("id");
    const workItem = state.graph.getWorkItemById(id);
    if (!workItem) {
      return c.json({ error: "Work item not found" }, 404);
    }

    const events = state.graph.getEventsForWorkItem(id);
    if (events.length === 0) {
      return c.json({ summary: `No conversation history for ${id}.` });
    }

    // Create summarizer on demand from classifier config
    const { baseUrl, model, apiKey } = state.config.classifier.provider;
    const summarizer = new Summarizer({ baseUrl, model, apiKey });

    const summary = await summarizer.summarize(events, id);

    // Cache it
    const latestEvent = events[events.length - 1];
    state.graph.upsertSummary({
      workItemId: id,
      summaryText: summary,
      latestEventId: latestEvent.id,
    });

    return c.json({ summary });
  });

  // --- GET /api/fleet ---
  app.get("/api/fleet", (c) => {
    const items = state.graph.getFleetItems();

    // Build fleet inputs for anomaly detection
    const fleetInputs: FleetItemInput[] = items.map((item) => {
      const events = state.graph.getEventsForWorkItem(item.workItem.id);
      return {
        workItemId: item.workItem.id,
        currentAtcStatus: item.workItem.currentAtcStatus,
        latestEventTimestamp: item.latestEvent?.timestamp ?? item.workItem.updatedAt,
        agentLastSeen: item.agent?.lastSeen ?? null,
        eventStatuses: events.map((e) => e.status),
        title: item.workItem.title,
      };
    });

    const anomalyConfig = (state.config as any).anomalies ?? {
      staleThresholdHours: 4,
      silentAgentThresholdHours: 2,
    };

    const now = new Date();
    const enrichedItems = items.map((item, idx) => {
      const anomalies = detectAnomalies(
        fleetInputs[idx],
        fleetInputs.filter((_, i) => i !== idx),
        anomalyConfig,
        now,
      );
      return { ...item, anomalies };
    });

    return c.json({ items: enrichedItems });
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
      jiraEmail?: string;
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

      // Write .env with all values
      const envLines: string[] = [];
      if (body.slackToken) envLines.push(`ATC_SLACK_TOKEN=${body.slackToken}`);
      if (body.llmApiKey) envLines.push(`ATC_LLM_API_KEY=${body.llmApiKey}`);
      if (body.llmBaseUrl) envLines.push(`ATC_LLM_BASE_URL=${body.llmBaseUrl}`);
      if (body.llmModel) envLines.push(`ATC_LLM_MODEL=${body.llmModel}`);

      // Jira: base64-encode email:token for Basic auth
      // ATC_JIRA_API_TOKEN stores the raw API token; ATC_JIRA_TOKEN stores the computed Basic auth credential.
      let jiraAuthToken: string | undefined;
      if (body.jiraToken && body.jiraEmail) {
        jiraAuthToken = Buffer.from(`${body.jiraEmail}:${body.jiraToken}`).toString("base64");
      } else if (body.jiraToken && !body.jiraEmail) {
        // No email provided — treat the token as already base64-encoded (legacy path)
        jiraAuthToken = body.jiraToken;
      }
      if (body.jiraEmail) envLines.push(`ATC_JIRA_EMAIL=${body.jiraEmail}`);
      if (body.jiraToken) envLines.push(`ATC_JIRA_API_TOKEN=${body.jiraToken}`);
      if (jiraAuthToken) envLines.push(`ATC_JIRA_TOKEN=${jiraAuthToken}`);
      if (body.jiraBaseUrl) envLines.push(`ATC_JIRA_BASE_URL=${body.jiraBaseUrl}`);

      if (envLines.length > 0) {
        writeFileSync(resolve(projectRoot, ".env"), envLines.join("\n") + "\n", "utf-8");
        log.info("Wrote .env");

        // Also set env vars in current process so config reload picks them up
        if (body.slackToken) process.env.ATC_SLACK_TOKEN = body.slackToken;
        if (body.llmApiKey) process.env.ATC_LLM_API_KEY = body.llmApiKey;
        if (body.llmBaseUrl) process.env.ATC_LLM_BASE_URL = body.llmBaseUrl;
        if (body.llmModel) process.env.ATC_LLM_MODEL = body.llmModel;
        if (body.jiraEmail) process.env.ATC_JIRA_EMAIL = body.jiraEmail;
        if (body.jiraToken) process.env.ATC_JIRA_API_TOKEN = body.jiraToken;
        if (jiraAuthToken) process.env.ATC_JIRA_TOKEN = jiraAuthToken;
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
        const slackRl = createRateLimiter({
          name: "slack",
          maxPerMinute: state.config.rateLimits?.slack?.maxPerMinute ?? 25,
        });
        slack.setRateLimiter(slackRl);
        await slack.connect({ token: body.slackToken });
        state.platformAdapter = slack;
        log.info("Slack adapter reconnected");
      }

      if (jiraAuthToken && body.jiraBaseUrl) {
        const jira = new JiraAdapter();
        const jiraRl = createRateLimiter({
          name: "jira",
          maxPerMinute: state.config.rateLimits?.jira?.maxPerMinute ?? 30,
        });
        jira.setRateLimiter(jiraRl);
        await jira.connect({ token: jiraAuthToken, baseUrl: body.jiraBaseUrl });
        state.taskAdapter = jira;
        log.info("Jira adapter reconnected");
      }

      // Recreate classifier with new config
      state.classifier = Classifier.fromConfig(state.config);
      const llmRl = createRateLimiter({
        name: "llm",
        maxPerMinute: state.config.rateLimits?.llm?.maxPerMinute ?? 4,
      });
      state.classifier.setRateLimiter(llmRl);

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

  // --- GET /api/setup/prefill ---
  // Returns env var values to pre-populate the setup form.
  // Safe to expose over localhost — values are already on this machine.
  app.get("/api/setup/prefill", (c) => {
    return c.json({
      slackToken: process.env.ATC_SLACK_TOKEN ?? "",
      llmApiKey: process.env.ATC_LLM_API_KEY ?? "",
      llmBaseUrl: process.env.ATC_LLM_BASE_URL ?? "https://api.anthropic.com/v1",
      llmModel: process.env.ATC_LLM_MODEL ?? "claude-sonnet-4-6",
      jiraEmail: process.env.ATC_JIRA_EMAIL ?? "",
      jiraToken: process.env.ATC_JIRA_API_TOKEN ?? "",
      jiraBaseUrl: process.env.ATC_JIRA_BASE_URL ?? "",
    });
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

    const platformMeta: Record<string, unknown> = {};
    if (state.platformAdapter?.name === "slack") {
      const slack = state.platformAdapter as import("./adapters/platforms/slack/index.js").SlackAdapter;
      platformMeta.slackWorkspaceUrl = slack.getWorkspaceUrl?.() ?? null;
    }

    return c.json({
      configured: slackConfigured && llmConfigured,
      slack: slackConfigured,
      llm: llmConfigured,
      jira: jiraConfigured,
      platformMeta,
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

  // 3. Create rate limiters
  const llmLimiter = createRateLimiter({
    name: "llm",
    maxPerMinute: config.rateLimits?.llm?.maxPerMinute ?? 4,
  });
  const slackLimiter = createRateLimiter({
    name: "slack",
    maxPerMinute: config.rateLimits?.slack?.maxPerMinute ?? 25,
  });
  const jiraLimiter = createRateLimiter({
    name: "jira",
    maxPerMinute: config.rateLimits?.jira?.maxPerMinute ?? 30,
  });

  // 4. Create core components
  const graph = new ContextGraph(db);
  const classifier = Classifier.fromConfig(config, projectRoot);
  classifier.setRateLimiter(llmLimiter);
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

  // 5. If Slack configured, create adapter and connect
  const slackToken = process.env.ATC_SLACK_TOKEN;
  if (slackToken) {
    try {
      const slack = new SlackAdapter();
      slack.setRateLimiter(slackLimiter);
      await slack.connect({ token: slackToken });
      state.platformAdapter = slack;
      log.info("Slack adapter connected");

      // Backfill agent names and avatars from Slack user data.
      // Agents whose name is still a raw Slack user ID (e.g. "U0399K5KCQ3") get
      // their display name resolved. Agents missing avatars get them filled in.
      const agents = graph.getAllAgents();
      const users = await slack.getUsers();
      let backfilled = 0;
      for (const agent of agents) {
        const slackName = users.get(agent.platformUserId);
        const avatar = slack.getUserAvatar(agent.platformUserId);
        const needsName = agent.name === agent.platformUserId && slackName;
        const needsAvatar = !agent.avatarUrl && avatar;
        if (needsName || needsAvatar) {
          graph.upsertAgent({
            id: agent.id,
            name: needsName ? slackName! : agent.name,
            platform: agent.platform,
            platformUserId: agent.platformUserId,
            avatarUrl: avatar || agent.avatarUrl,
          });
          backfilled++;
        }
      }
      if (backfilled > 0) {
        log.info(`Backfilled names/avatars for ${backfilled} agents`);
      }

      // Backfill channel privacy into platform_meta for existing threads
      // This runs a direct SQL update for efficiency — no need to load each thread
      const channelIds = db.db.prepare(
        "SELECT DISTINCT channel_id FROM threads WHERE platform = 'slack' AND platform_meta = '{}'"
      ).all() as Array<{ channel_id: string }>;
      let privUpdated = 0;
      for (const { channel_id } of channelIds) {
        if (slack.isChannelPrivate(channel_id)) {
          db.db.prepare(
            "UPDATE threads SET platform_meta = '{\"isPrivate\":true}' WHERE channel_id = ?"
          ).run(channel_id);
          privUpdated++;
        }
      }
      if (privUpdated > 0) {
        log.info(`Backfilled private flag for ${privUpdated} channels`);
      }
    } catch (err) {
      log.error("Failed to connect Slack adapter", err);
    }
  } else {
    log.warn("No ATC_SLACK_TOKEN set — Slack adapter disabled");
  }

  // 6. If Jira configured, create adapter and connect
  if (config.jira.enabled && process.env.ATC_JIRA_TOKEN) {
    try {
      const jira = new JiraAdapter();
      jira.setRateLimiter(jiraLimiter);
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
  } else {
    log.warn("No platform adapter available — pipeline not started (configure via POST /api/setup)");
  }

  // 7. Create and start Hono server — before pipeline polling so the server
  //    is reachable immediately (initial poll can block for minutes with rate limiting)
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
    if (state.pipeline) {
      // Start pipeline after server is bound so the server is immediately reachable.
      // Initial poll can take minutes with rate limiting — run it in the background.
      state.pipeline.start().catch((err) => log.error("Pipeline start failed", err));
      log.info("Pipeline polling started in background");
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
