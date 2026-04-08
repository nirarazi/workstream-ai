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
import { Pipeline } from "./pipeline.js";
import type { MessagingAdapter } from "./adapters/messaging/interface.js";
import type { TaskAdapter } from "./adapters/tasks/interface.js";
import { createMessagingAdapter, createTaskAdapter, getMessagingAdapterSetupInfo, getTaskAdapterSetupInfo } from "./adapters/registry.js";
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
  messagingAdapter: MessagingAdapter | null;
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

    // Check messaging adapter's own throttling state
    const platformThrottled = state.messagingAdapter?.isThrottling ?? false;

    return c.json({
      ok: true,
      uptime,
      pipeline: {
        lastPoll: state.lastPoll?.toISOString() ?? null,
        processed: state.processed,
      },
      services: {
        ...(state.messagingAdapter
          ? { [state.messagingAdapter.displayName]: platformThrottled ? "degraded" as const : "ok" as const }
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
    if (!state.messagingAdapter) {
      return c.json({ ok: false, error: "No messaging adapter configured" }, 503);
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
        await state.messagingAdapter.replyToThread(body.threadId, body.channelId, body.message);
        return c.json({ ok: true });
      }

      // Case 2: New top-level message in a channel
      if (body.channelId && !body.threadId) {
        const result = await state.messagingAdapter.postMessage(body.channelId, body.message);
        // Proactively link to work item if provided
        if (body.workItemId) {
          state.graph.upsertThread({
            id: result.threadId,
            channelId: body.channelId,
            channelName: "",
            platform: state.messagingAdapter.name,
            workItemId: body.workItemId,
            lastActivity: new Date().toISOString(),
            messageCount: 1,
          });
        }
        return c.json({ ok: true, threadId: result.threadId, channelId: body.channelId });
      }

      // Case 3: DM to a user
      if (body.targetUserId) {
        const result = await state.messagingAdapter.sendDirectMessage(body.targetUserId, body.message);
        if (body.workItemId) {
          state.graph.upsertThread({
            id: result.threadId,
            channelId: result.channelId,
            channelName: "",
            platform: state.messagingAdapter.name,
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
    if (!state.messagingAdapter) {
      return c.json({ error: "No messaging adapter configured" }, 503);
    }
    const body = await c.req.json<{ url: string }>();
    if (!body.url) {
      return c.json({ error: "Missing url" }, 400);
    }

    // Delegate URL parsing to the messaging adapter
    const parsed = state.messagingAdapter.parseThreadUrl?.(body.url);
    if (!parsed) {
      return c.json({ error: "Unrecognized thread URL format" }, 400);
    }
    const { threadId: threadTs, channelId } = parsed;

    // Fetch thread if not already in graph
    if (!state.graph.getThreadById(threadTs)) {
      try {
        const messages = await state.messagingAdapter.getThreadMessages(threadTs, channelId);
        state.graph.upsertThread({
          id: threadTs,
          channelId,
          channelName: "",
          platform: state.messagingAdapter.name,
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
    if (!state.messagingAdapter) {
      return c.json({ ok: false, error: "No messaging adapter configured" }, 503);
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
        const messages = await state.messagingAdapter.getThreadMessages(
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
        const r = await state.messagingAdapter.postMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: body.targetId };
      } else {
        const r = await state.messagingAdapter.sendDirectMessage(body.targetId, composedMessage);
        result = { threadId: r.threadId, channelId: r.channelId };
      }

      // Proactively link new thread to source work item
      if (sourceThread.workItemId) {
        state.graph.upsertThread({
          id: result.threadId,
          channelId: result.channelId,
          channelName: "",
          platform: state.messagingAdapter.name,
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
          const projectKey = body.projectKey ?? state.config.taskAdapter?.defaultProject;
          if (!projectKey) {
            return c.json({ ok: false, error: "projectKey required (or set taskAdapter.defaultProject in config)" }, 400);
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

      // If there's a message and a messaging adapter, post it to the related thread
      if (body.message && state.messagingAdapter) {
        const threads = state.graph.getThreadsForWorkItem(body.workItemId);
        if (threads.length > 0) {
          const thread = threads[0];
          await state.messagingAdapter.replyToThread(thread.id, thread.channelId, body.message);
        }
      }

      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Action failed", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- GET /api/setup/adapters ---
  // Returns registered adapter schemas for dynamic setup form rendering.
  // envVar is stripped — it's server-internal for prefill logic.
  app.get("/api/setup/adapters", (c) => {
    function stripEnvVar(infos: ReturnType<typeof getMessagingAdapterSetupInfo>) {
      return infos.map((info) => ({
        ...info,
        fields: info.fields.map(({ envVar, ...rest }) => rest),
      }));
    }

    return c.json({
      messaging: stripEnvVar(getMessagingAdapterSetupInfo()),
      task: stripEnvVar(getTaskAdapterSetupInfo()),
    });
  });

  // --- POST /api/setup ---
  app.post("/api/setup", async (c) => {
    const body = await c.req.json<{
      messaging?: {
        adapter: string;
        fields: Record<string, string>;
      };
      task?: {
        adapter: string;
        fields: Record<string, string>;
      };
      llm?: {
        apiKey: string;
        baseUrl: string;
        model: string;
      };
      rateLimits?: Record<string, number>;
    }>();

    try {
      const projectRoot = findProjectRoot();
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { stringify: toYaml } = await import("yaml");

      const configDir = resolve(projectRoot, "config");
      mkdirSync(configDir, { recursive: true });

      const localConfig: Record<string, unknown> = {};
      const envLines: string[] = [];

      // --- LLM ---
      if (body.llm) {
        if (body.llm.baseUrl || body.llm.model) {
          localConfig.classifier = {
            provider: {
              baseUrl: body.llm.baseUrl ?? state.config.classifier.provider.baseUrl,
              model: body.llm.model ?? state.config.classifier.provider.model,
            },
          };
        }
        if (body.llm.apiKey) envLines.push(`ATC_LLM_API_KEY=${body.llm.apiKey}`);
        if (body.llm.baseUrl) envLines.push(`ATC_LLM_BASE_URL=${body.llm.baseUrl}`);
        if (body.llm.model) envLines.push(`ATC_LLM_MODEL=${body.llm.model}`);
      }

      // --- Messaging adapter ---
      if (body.messaging) {
        const adapterName = body.messaging.adapter;
        const fields = body.messaging.fields;

        // Look up adapter to get envVar mappings
        const adapter = createMessagingAdapter(adapterName);
        const setupInfo = adapter.getSetupInfo();

        // Write env vars using the declared envVar names
        for (const fieldDef of setupInfo.fields) {
          if (fieldDef.envVar && fields[fieldDef.key]) {
            envLines.push(`${fieldDef.envVar}=${fields[fieldDef.key]}`);
          }
        }
      }

      // --- Task adapter ---
      if (body.task) {
        const adapterName = body.task.adapter;
        const fields = body.task.fields;

        const adapter = createTaskAdapter(adapterName);
        const setupInfo = adapter.getSetupInfo();

        // Write env vars using the declared envVar names
        for (const fieldDef of setupInfo.fields) {
          if (fieldDef.envVar && fields[fieldDef.key]) {
            envLines.push(`${fieldDef.envVar}=${fields[fieldDef.key]}`);
          }
        }

        // Prepare credentials (e.g. Jira base64 encoding)
        const prepared = adapter.prepareCredentials
          ? adapter.prepareCredentials(fields)
          : fields;

        // Write the computed auth token env var if adapter produces one
        // For Jira: the base64 token goes to ATC_JIRA_TOKEN
        if (adapterName === "jira" && prepared.token !== fields.token) {
          envLines.push(`ATC_JIRA_TOKEN=${prepared.token}`);
        }

        // Write non-sensitive config
        if (fields.baseUrl) {
          localConfig.taskAdapter = {
            enabled: true,
            baseUrl: fields.baseUrl,
          };
        }
      }

      // --- Rate limits ---
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

      // Write config/local.yaml
      writeFileSync(resolve(configDir, "local.yaml"), toYaml(localConfig), "utf-8");
      log.info("Wrote config/local.yaml");

      // Write .env
      if (envLines.length > 0) {
        writeFileSync(resolve(projectRoot, ".env"), envLines.join("\n") + "\n", "utf-8");
        log.info("Wrote .env");

        // Set env vars in current process
        for (const line of envLines) {
          const eqIndex = line.indexOf("=");
          if (eqIndex !== -1) {
            process.env[line.slice(0, eqIndex)] = line.slice(eqIndex + 1);
          }
        }
      }

      // Reload config
      resetConfig();
      state.config = loadConfig(projectRoot);

      // Stop existing pipeline
      if (state.pipeline) {
        state.pipeline.stop();
        state.pipeline = null;
      }

      // Recreate rate limiters
      const rlDefaults: Record<string, { maxPerMinute: number; displayName: string }> = {
        llm: { maxPerMinute: 4, displayName: "LLM" },
        slack: { maxPerMinute: 25, displayName: "Slack" },
        jira: { maxPerMinute: 30, displayName: "Jira" },
      };
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

      // Reconnect messaging adapter
      if (body.messaging) {
        const adapter = createMessagingAdapter(body.messaging.adapter);
        (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(
          newLimiters[body.messaging.adapter],
        );
        const creds = adapter.prepareCredentials
          ? adapter.prepareCredentials(body.messaging.fields)
          : body.messaging.fields;
        await adapter.connect(creds as Record<string, string> & { token: string });
        state.messagingAdapter = adapter;
        log.info("Messaging adapter reconnected");
      }

      // Reconnect task adapter
      if (body.task) {
        const adapter = createTaskAdapter(body.task.adapter);
        (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(
          newLimiters[body.task.adapter],
        );
        const creds = adapter.prepareCredentials
          ? adapter.prepareCredentials(body.task.fields)
          : body.task.fields;
        await adapter.connect(creds as Record<string, string> & { token: string });
        state.taskAdapter = adapter;
        log.info("Task adapter reconnected");
      }

      // Recreate classifier
      state.classifier = Classifier.fromConfig(state.config);
      if (newLimiters.llm) state.classifier.setRateLimiter(newLimiters.llm);

      // Restart pipeline if we have a messaging adapter
      if (state.messagingAdapter) {
        state.pipeline = new Pipeline(
          state.messagingAdapter,
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
  app.get("/api/setup/prefill", (c) => {
    const result: Record<string, unknown> = {};

    // Messaging adapters — check env vars for each registered adapter
    const messagingInfos = getMessagingAdapterSetupInfo();
    for (const info of messagingInfos) {
      const fields: Record<string, string> = {};
      let hasValues = false;
      for (const field of info.fields) {
        if (field.envVar) {
          const val = process.env[field.envVar] ?? "";
          if (val) {
            fields[field.key] = val;
            hasValues = true;
          }
        }
      }
      if (hasValues) {
        result.messaging = { adapter: info.name, fields };
        break;
      }
    }

    // Task adapters
    const taskInfos = getTaskAdapterSetupInfo();
    for (const info of taskInfos) {
      const fields: Record<string, string> = {};
      let hasValues = false;
      for (const field of info.fields) {
        if (field.envVar) {
          const val = process.env[field.envVar] ?? "";
          if (val) {
            fields[field.key] = val;
            hasValues = true;
          }
        }
      }
      if (hasValues) {
        result.task = { adapter: info.name, fields };
        break;
      }
    }

    // LLM
    result.llm = {
      apiKey: process.env.ATC_LLM_API_KEY ?? "",
      baseUrl: process.env.ATC_LLM_BASE_URL ?? "https://api.anthropic.com/v1",
      model: process.env.ATC_LLM_MODEL ?? "claude-sonnet-4-6",
    };

    // Rate limits
    const rateLimits: Record<string, { maxPerMinute: number; displayName: string }> = {};
    for (const [name, limiter] of Object.entries(state.rateLimiters)) {
      rateLimits[name] = { maxPerMinute: limiter.limit, displayName: limiter.displayName };
    }
    result.rateLimits = rateLimits;

    return c.json(result);
  });

  // --- GET /api/setup/status ---
  app.get("/api/setup/status", (c) => {
    const llmConfigured = !!(
      state.config.classifier.provider.apiKey ||
      state.config.classifier.provider.baseUrl.includes("localhost") ||
      state.config.classifier.provider.baseUrl.includes("127.0.0.1")
    );

    const messagingConnected = !!state.messagingAdapter;
    const taskConnected = !!state.taskAdapter;

    const platformMeta: Record<string, unknown> = state.messagingAdapter?.getMetadata?.() ?? {};

    return c.json({
      configured: messagingConnected && llmConfigured,
      llm: llmConfigured,
      adapters: {
        messaging: messagingConnected
          ? { name: state.messagingAdapter!.name, connected: true }
          : null,
        task: taskConnected
          ? { name: state.taskAdapter!.name, connected: true }
          : null,
      },
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

  // 3. Create rate limiters from config (dynamic — not hardcoded per adapter)
  const defaultRateLimits: Record<string, { maxPerMinute: number; displayName: string }> = {
    llm: { maxPerMinute: 4, displayName: "LLM" },
    slack: { maxPerMinute: 25, displayName: "Slack" },
    jira: { maxPerMinute: 30, displayName: "Jira" },
  };
  const rateLimiters: Record<string, RateLimiter> = {};
  // Merge config overrides into defaults
  if (config.rateLimits) {
    for (const [name, cfg] of Object.entries(config.rateLimits)) {
      if (cfg?.maxPerMinute) {
        defaultRateLimits[name] = {
          ...defaultRateLimits[name],
          maxPerMinute: cfg.maxPerMinute,
          displayName: defaultRateLimits[name]?.displayName ?? name,
        };
      }
    }
  }
  for (const [name, entry] of Object.entries(defaultRateLimits)) {
    rateLimiters[name] = createRateLimiter({ name, ...entry });
  }

  // 4. Create core components
  const graph = new ContextGraph(db);
  const classifier = Classifier.fromConfig(config, projectRoot);
  classifier.setRateLimiter(rateLimiters.llm);
  const extractor = new DefaultExtractor({
    ticketPatterns: config.extractors.ticketPatterns,
    prPatterns: config.extractors.prPatterns,
    ticketPrefixes: config.taskAdapter.ticketPrefixes,
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
    messagingAdapter: null,
    taskAdapter: null,
    rateLimiters,
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
  };

  // 5. If messaging adapter configured, create and connect via registry
  // Import adapter modules so they self-register with the registry
  await import("./adapters/messaging/slack/index.js");
  await import("./adapters/tasks/jira/index.js");

  const slackToken = process.env.ATC_SLACK_TOKEN;
  if (slackToken) {
    try {
      const adapter = createMessagingAdapter("slack");
      (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(rateLimiters.slack);
      await adapter.connect({ token: slackToken });
      state.messagingAdapter = adapter;
      log.info(`${adapter.displayName} adapter connected`);

      // Backfill agent data from platform
      const agentsBackfilled = await adapter.backfillAgents?.(graph) ?? 0;
      if (agentsBackfilled > 0) {
        log.info(`Backfilled names/avatars for ${agentsBackfilled} agents`);
      }

      // Backfill thread metadata from platform
      const threadsBackfilled = await adapter.backfillThreads?.(db) ?? 0;
      if (threadsBackfilled > 0) {
        log.info(`Backfilled metadata for ${threadsBackfilled} channels`);
      }
    } catch (err) {
      log.error("Failed to connect messaging adapter", err);
    }
  } else {
    log.warn("No ATC_SLACK_TOKEN set — messaging adapter disabled");
  }

  // 6. If task adapter configured, create and connect via registry
  if (config.taskAdapter.enabled && process.env.ATC_JIRA_TOKEN) {
    try {
      const adapter = createTaskAdapter("jira");
      (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(rateLimiters.jira);
      await adapter.connect({
        token: process.env.ATC_JIRA_TOKEN,
        baseUrl: process.env.ATC_JIRA_BASE_URL ?? config.taskAdapter.baseUrl ?? "",
      });
      state.taskAdapter = adapter;
      log.info(`${adapter.displayName} adapter connected`);
    } catch (err) {
      log.error("Failed to connect task adapter", err);
    }
  }

  // 6. Create pipeline if messaging adapter is available
  if (state.messagingAdapter) {
    state.pipeline = new Pipeline(
      state.messagingAdapter,
      state.classifier,
      state.graph,
      state.linker,
      state.taskAdapter ?? undefined,
      state.config,
    );
  } else {
    log.warn("No messaging adapter available — pipeline not started (configure via POST /api/setup)");
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
