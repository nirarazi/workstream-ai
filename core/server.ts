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
import { Sidekick, type SidekickMessage } from "./sidekick/index.js";

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
  rateLimiters: Record<string, RateLimiter>;
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
    const llmBackoff = state.classifier.getBackoffState();
    const llmThrottled = state.rateLimiters.llm?.isThrottling ?? false;
    const llmDegraded = llmBackoff?.active || llmThrottled;

    // Check Slack adapter's own per-method throttling state
    const slackAdapter = state.platformAdapter as { isThrottling?: boolean } | null;
    const slackThrottled = slackAdapter?.isThrottling ?? false;

    return c.json({
      ok: true,
      uptime,
      pipeline: {
        lastPoll: state.lastPoll?.toISOString() ?? null,
        processed: state.processed,
      },
      services: {
        ...(state.platformAdapter
          ? { [state.platformAdapter.displayName]: slackThrottled ? "degraded" as const : "ok" as const }
          : {}),
        ...(state.taskAdapter ? { [state.taskAdapter.displayName]: "ok" as const } : {}),
        LLM: llmDegraded ? "degraded" as const : "ok" as const,
      },
      llmBackoff,
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

  // --- POST /api/sidekick ---
  app.post("/api/sidekick", async (c) => {
    const body = await c.req.json<{
      question?: string;
      history?: SidekickMessage[];
    }>();

    if (!body.question) {
      return c.json({ error: "Missing required field: question" }, 400);
    }

    const sidekickConfig = (state.config as any).sidekick ?? {
      enabled: true,
      maxToolCalls: 5,
      maxHistoryTurns: 10,
    };

    const { baseUrl, model, apiKey } = state.config.classifier.provider;
    const sidekick = new Sidekick(
      { baseUrl, model, apiKey, maxToolCalls: sidekickConfig.maxToolCalls },
      state.graph,
    );

    const history = (body.history ?? []).slice(-sidekickConfig.maxHistoryTurns);
    const result = await sidekick.ask(body.question, history);

    return c.json(result);
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

    const body = await c.req.json<{
      threadId?: string;
      channelId?: string;
      targetUserId?: string;
      message: string;
      workItemId?: string;
    }>();

    if (!body.message) {
      return c.json({ ok: false, error: "Missing required field: message" }, 400);
    }

    try {
      // Case 1: Reply to existing thread (original behavior)
      if (body.threadId && body.channelId) {
        await state.platformAdapter.replyToThread(body.threadId, body.channelId, body.message);
        return c.json({ ok: true });
      }

      // Case 2: New top-level message in a channel
      if (body.channelId && !body.threadId) {
        const result = await state.platformAdapter.postMessage(body.channelId, body.message);
        // Proactively link to work item if provided
        if (body.workItemId) {
          state.graph.upsertThread({
            id: result.threadId,
            channelId: body.channelId,
            channelName: "",
            platform: state.platformAdapter.name,
            workItemId: body.workItemId,
            lastActivity: new Date().toISOString(),
            messageCount: 1,
          });
        }
        return c.json({ ok: true, threadId: result.threadId, channelId: body.channelId });
      }

      // Case 3: DM to a user
      if (body.targetUserId) {
        const result = await state.platformAdapter.sendDirectMessage(body.targetUserId, body.message);
        if (body.workItemId) {
          state.graph.upsertThread({
            id: result.threadId,
            channelId: result.channelId,
            channelName: "",
            platform: state.platformAdapter.name,
            workItemId: body.workItemId,
            lastActivity: new Date().toISOString(),
            messageCount: 1,
          });
        }
        return c.json({ ok: true, threadId: result.threadId, channelId: result.channelId });
      }

      return c.json({ ok: false, error: "Provide threadId+channelId, channelId alone, or targetUserId" }, 400);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Reply failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- POST /api/work-item/:id/link-thread ---
  app.post("/api/work-item/:id/link-thread", async (c) => {
    const id = c.req.param("id");
    if (!state.graph.getWorkItemById(id)) {
      return c.json({ error: "Work item not found" }, 404);
    }
    const body = await c.req.json<{ threadId: string }>();
    if (!body.threadId) {
      return c.json({ error: "Missing threadId" }, 400);
    }
    state.graph.linkThread(body.threadId, id);
    return c.json({ ok: true });
  });

  // --- POST /api/work-item/:id/unlink-thread ---
  app.post("/api/work-item/:id/unlink-thread", async (c) => {
    const id = c.req.param("id");
    if (!state.graph.getWorkItemById(id)) {
      return c.json({ error: "Work item not found" }, 404);
    }
    const body = await c.req.json<{ threadId: string }>();
    if (!body.threadId) {
      return c.json({ error: "Missing threadId" }, 400);
    }
    state.graph.unlinkThread(body.threadId);
    return c.json({ ok: true });
  });

  // --- GET /api/threads/unlinked ---
  app.get("/api/threads/unlinked", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    const q = c.req.query("q") || undefined;
    const threads = state.graph.getUnlinkedThreads(isNaN(limit) ? 20 : limit, q);
    return c.json({ threads });
  });

  // --- POST /api/work-item/:id/link-url ---
  app.post("/api/work-item/:id/link-url", async (c) => {
    const id = c.req.param("id");
    if (!state.graph.getWorkItemById(id)) {
      return c.json({ error: "Work item not found" }, 404);
    }
    if (!state.platformAdapter) {
      return c.json({ error: "No platform adapter configured" }, 503);
    }
    const body = await c.req.json<{ url: string }>();
    if (!body.url) {
      return c.json({ error: "Missing url" }, 400);
    }

    // Parse Slack thread URL: https://team.slack.com/archives/C001/p1711900000000100
    const match = body.url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
    if (!match) {
      return c.json({ error: "Invalid Slack thread URL" }, 400);
    }
    const channelId = match[1];
    const rawTs = match[2];
    const threadTs = rawTs.slice(0, 10) + "." + rawTs.slice(10);

    // Fetch thread if not already in graph
    if (!state.graph.getThreadById(threadTs)) {
      try {
        const messages = await state.platformAdapter.getThreadMessages(threadTs, channelId);
        state.graph.upsertThread({
          id: threadTs,
          channelId,
          channelName: "",
          platform: state.platformAdapter.name,
          lastActivity: messages[0]?.timestamp ?? new Date().toISOString(),
          messageCount: messages.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Failed to fetch thread: ${message}` }, 500);
      }
    }

    state.graph.linkThread(threadTs, id);
    return c.json({ ok: true, threadId: threadTs });
  });

  // --- POST /api/forward ---
  app.post("/api/forward", async (c) => {
    if (!state.platformAdapter) {
      return c.json({ ok: false, error: "No platform adapter configured" }, 503);
    }

    const body = await c.req.json<{
      sourceThreadId: string;
      sourceChannelId: string;
      targetId: string;
      targetType: "user" | "channel";
      quoteMode?: "latest" | "full";
      includeSummary?: boolean;
      note?: string;
    }>();

    if (!body.sourceThreadId || !body.targetId || !body.targetType) {
      return c.json({ ok: false, error: "Missing required fields: sourceThreadId, targetId, targetType" }, 400);
    }

    const sourceThread = state.graph.getThreadById(body.sourceThreadId);
    if (!sourceThread) {
      return c.json({ ok: false, error: "Source thread not found" }, 404);
    }

    // Build the forwarded message
    const parts: string[] = [];
    if (body.note) {
      parts.push(body.note);
    }

    const channelName = sourceThread.channelName || sourceThread.channelId;
    const quoteMode = body.quoteMode ?? "latest";

    try {
      if (quoteMode === "latest") {
        const events = state.graph.getEventsForThread(body.sourceThreadId);
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
          parts.push(`> Forwarded from #${channelName}:\n> "${lastEvent.rawText}"`);
        }
      } else {
        const messages = await state.platformAdapter.getThreadMessages(
          body.sourceThreadId, body.sourceChannelId,
        );
        const quoted = messages
          .map((m) => `> ${m.userName}: ${m.text}`)
          .join("\n");
        parts.push(`> Forwarded from #${channelName}:\n${quoted}`);
      }

      if (body.includeSummary && sourceThread.workItemId) {
        const cached = state.graph.getSummary(sourceThread.workItemId);
        if (cached) {
          parts.push(`Summary:\n${cached.summaryText}`);
        }
      }

      const composedMessage = parts.join("\n\n");

      let result: { threadId: string; channelId: string };
      if (body.targetType === "channel") {
        const r = await state.platformAdapter.postMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: body.targetId };
      } else {
        const r = await state.platformAdapter.sendDirectMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: r.channelId };
      }

      // Proactively link new thread to source work item
      if (sourceThread.workItemId) {
        state.graph.upsertThread({
          id: result.threadId,
          channelId: result.channelId,
          channelName: "",
          platform: state.platformAdapter.name,
          workItemId: sourceThread.workItemId,
          lastActivity: new Date().toISOString(),
          messageCount: 1,
        });
      }

      return c.json({ ok: true, threadId: result.threadId, channelId: result.channelId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Forward failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- POST /api/action ---
  app.post("/api/action", async (c) => {
    const body = await c.req.json<{
      workItemId: string;
      action: "approve" | "redirect" | "close" | "snooze" | "create_ticket";
      message?: string;
      snoozeDuration?: number;
      projectKey?: string;
    }>();

    if (!body.workItemId || !body.action) {
      return c.json({ ok: false, error: "Missing required fields: workItemId, action" }, 400);
    }

    const validActions = new Set(["approve", "redirect", "close", "snooze", "create_ticket"]);
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

        case "create_ticket": {
          if (!state.taskAdapter?.createWorkItem) {
            return c.json({ ok: false, error: "No task adapter with ticket creation support" }, 400);
          }
          const projectKey = body.projectKey ?? state.config.jira?.defaultProject;
          if (!projectKey) {
            return c.json({ ok: false, error: "projectKey required (or set jira.defaultProject in config)" }, 400);
          }
          // Build description from conversation history
          const events = state.graph.getEventsForWorkItem(body.workItemId);
          const description = events
            .slice(-5)
            .map((e) => e.rawText)
            .filter(Boolean)
            .join("\n\n");

          const ticket = await state.taskAdapter.createWorkItem({
            title: workItem.title || "Untitled",
            description,
            projectKey,
          });

          // Relink: update the old synthetic work item's threads and events to point to the real ticket
          const threads = state.graph.getThreadsForWorkItem(body.workItemId);
          for (const t of threads) {
            state.graph.upsertThread({
              id: t.id,
              channelId: t.channelId,
              channelName: t.channelName,
              platform: t.platform,
              workItemId: ticket.id,
              lastActivity: t.lastActivity,
              messageCount: t.messageCount,
            });
          }

          // Create the real work item
          state.graph.upsertWorkItem({
            id: ticket.id,
            source: state.taskAdapter.name,
            title: ticket.title,
            externalStatus: ticket.status,
            assignee: ticket.assignee,
            url: ticket.url,
            currentAtcStatus: workItem.currentAtcStatus,
            currentConfidence: workItem.currentConfidence,
          });

          // Mark the synthetic work item as completed (superseded)
          state.graph.upsertWorkItem({
            id: body.workItemId,
            source: workItem.source,
            currentAtcStatus: "completed",
          });

          log.info("Created ticket from synthetic work item", body.workItemId, "→", ticket.id);
          return c.json({ ok: true, ticketId: ticket.id, ticketUrl: ticket.url });
        }
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
      rateLimits?: Record<string, number>;
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

      // Rate limits — dynamic: persist whatever the client sends
      if (body.rateLimits && Object.keys(body.rateLimits).length > 0) {
        const rlConfig: Record<string, { maxPerMinute: number }> = {};
        for (const [name, maxPerMinute] of Object.entries(body.rateLimits)) {
          if (typeof maxPerMinute === "number" && maxPerMinute > 0) {
            rlConfig[name] = { maxPerMinute };
          }
        }
        if (Object.keys(rlConfig).length > 0) {
          localConfig.rateLimits = rlConfig;
        }
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

      // Recreate rate limiters — known defaults + any extras from config
      const rlDefaults: Record<string, { maxPerMinute: number; displayName: string }> = {
        llm: { maxPerMinute: 4, displayName: "LLM" },
        slack: { maxPerMinute: 25, displayName: "Slack" },
        jira: { maxPerMinute: 30, displayName: "Jira" },
      };
      // Carry over display names from existing limiters (community adapters may have registered theirs)
      for (const [name, limiter] of Object.entries(state.rateLimiters)) {
        if (!rlDefaults[name]) {
          rlDefaults[name] = { maxPerMinute: limiter.limit, displayName: limiter.displayName };
        }
      }
      if (state.config.rateLimits) {
        for (const [name, cfg] of Object.entries(state.config.rateLimits)) {
          if (cfg?.maxPerMinute) {
            rlDefaults[name] = { ...rlDefaults[name], maxPerMinute: cfg.maxPerMinute };
          }
        }
      }
      const newLimiters: Record<string, RateLimiter> = {};
      for (const [name, entry] of Object.entries(rlDefaults)) {
        newLimiters[name] = createRateLimiter({ name, ...entry });
      }
      state.rateLimiters = newLimiters;

      // Reconnect adapters
      if (body.slackToken) {
        const slack = new SlackAdapter();
        if (newLimiters.slack) slack.setRateLimiter(newLimiters.slack);
        await slack.connect({ token: body.slackToken });
        state.platformAdapter = slack;
        log.info("Slack adapter reconnected");
      }

      if (jiraAuthToken && body.jiraBaseUrl) {
        const jira = new JiraAdapter();
        if (newLimiters.jira) jira.setRateLimiter(newLimiters.jira);
        await jira.connect({ token: jiraAuthToken, baseUrl: body.jiraBaseUrl });
        state.taskAdapter = jira;
        log.info("Jira adapter reconnected");
      }

      // Recreate classifier with new config
      state.classifier = Classifier.fromConfig(state.config);
      if (newLimiters.llm) state.classifier.setRateLimiter(newLimiters.llm);

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
    // Build rate limits from whichever limiters are registered
    const rateLimits: Record<string, { maxPerMinute: number; displayName: string }> = {};
    for (const [name, limiter] of Object.entries(state.rateLimiters)) {
      rateLimits[name] = { maxPerMinute: limiter.limit, displayName: limiter.displayName };
    }

    return c.json({
      slackToken: process.env.ATC_SLACK_TOKEN ?? "",
      llmApiKey: process.env.ATC_LLM_API_KEY ?? "",
      llmBaseUrl: process.env.ATC_LLM_BASE_URL ?? "https://api.anthropic.com/v1",
      llmModel: process.env.ATC_LLM_MODEL ?? "claude-sonnet-4-6",
      jiraEmail: process.env.ATC_JIRA_EMAIL ?? "",
      jiraToken: process.env.ATC_JIRA_API_TOKEN ?? "",
      jiraBaseUrl: process.env.ATC_JIRA_BASE_URL ?? "",
      rateLimits,
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
    displayName: "LLM",
    maxPerMinute: config.rateLimits?.llm?.maxPerMinute ?? 4,
  });
  const slackLimiter = createRateLimiter({
    name: "slack",
    displayName: "Slack",
    maxPerMinute: config.rateLimits?.slack?.maxPerMinute ?? 25,
  });
  const jiraLimiter = createRateLimiter({
    name: "jira",
    displayName: "Jira",
    maxPerMinute: config.rateLimits?.jira?.maxPerMinute ?? 30,
  });

  // 4. Create core components
  const graph = new ContextGraph(db);
  const classifier = Classifier.fromConfig(config, projectRoot);
  classifier.setRateLimiter(llmLimiter);
  const extractor = new DefaultExtractor({
    ticketPatterns: config.extractors.ticketPatterns,
    prPatterns: config.extractors.prPatterns,
    ticketPrefixes: config.jira.ticketPrefixes,
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
    rateLimiters: { llm: llmLimiter, slack: slackLimiter, jira: jiraLimiter },
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
