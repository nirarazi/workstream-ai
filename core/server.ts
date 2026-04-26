// core/server.ts — Hono HTTP server exposing the workstream.ai engine API

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createLogger } from "./logger.js";
import { loadConfig, findProjectRoot, resetConfig, type Config } from "./config.js";
import { Database } from "./graph/db.js";
import { ContextGraph } from "./graph/index.js";
import { Classifier, createProvider, loadPrompt, buildFewShotMessages, buildOperatorContext } from "./classifier/index.js";
import { UsageTracker } from "./usage/tracker.js";
import { DefaultExtractor } from "./graph/extractors/default.js";
import { WorkItemLinker } from "./graph/linker.js";
import { createMessagingAdapter, createTaskAdapter, getMessagingAdapterSetupInfo, getTaskAdapterSetupInfo } from "./adapters/registry.js";
import { Pipeline } from "./pipeline.js";
import type { MessagingAdapter } from "./adapters/messaging/interface.js";
import type { TaskAdapter } from "./adapters/tasks/interface.js";
import { createRateLimiter, type RateLimiter } from "./rate-limiter.js";
import { Summarizer } from "./summarizer/index.js";
import { detectAnomalies, type FleetItemInput } from "./graph/anomalies.js";
import { Sidekick, type SidekickMessage } from "./sidekick/index.js";
import { buildUnifiedStatus, buildTimeline } from "./stream.js";
import type { OperatorIdentityMap } from "./types.js";

const log = createLogger("server");

// Adapters that manage their own rate limiting internally (not configurable via UI)
const SELF_RATE_LIMITED = new Set(["slack"]);

// --- Engine state (mutable, shared across routes) ---

export interface EngineState {
  config: Config;
  db: Database;
  graph: ContextGraph;
  classifier: Classifier;
  usageTracker: UsageTracker | null;
  linker: WorkItemLinker;
  pipeline: Pipeline | null;
  messagingAdapter: MessagingAdapter | null;
  taskAdapter: TaskAdapter | null;
  rateLimiters: Record<string, RateLimiter>;
  startedAt: Date;
  lastPoll: Date | null;
  processed: number;
  operatorIdentities: OperatorIdentityMap;
}

// --- App factory (testable without starting the server) ---

export function createApp(state: EngineState): Hono {
  const app = new Hono();

  // CORS for Vite dev server and Tauri WebView
  app.use(
    "/api/*",
    cors({
      origin: ["http://localhost:5173", "https://tauri.localhost", "http://tauri.localhost"],
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

    const llmUsage = state.usageTracker
      ? (() => {
          const today = state.usageTracker.getTodayUsage();
          const budget = state.usageTracker.getBudgetStatus();
          return {
            inputTokens: today.inputTokens,
            outputTokens: today.outputTokens,
            cost: today.cost,
            costSource: today.cost != null ? "configured" as const : null,
            dailyBudget: budget.dailyBudget,
            exhausted: budget.exhausted,
          };
        })()
      : null;

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
      llmUsage,
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

  // --- GET /api/work-item/:id/stream ---
  app.get("/api/work-item/:id/stream", async (c) => {
    const id = c.req.param("id");
    const workItem = state.graph.getWorkItemById(id);
    if (!workItem) {
      return c.json({ error: "Work item not found" }, 404);
    }

    const limit = Number(c.req.query("limit")) || 10;
    const before = c.req.query("before") || undefined;

    const threads = state.graph.getThreadsForWorkItemViaJunction(id);
    const { events, hasOlder } = state.graph.getEventsForWorkItemPaginated(id, limit, before);
    const agents = state.graph.getAgentsForWorkItem(id);
    const channels = state.graph.getChannelsForWorkItem(id);
    const enrichments = state.graph.getEnrichmentsForWorkItem(id);

    const agentMap = new Map<string, string>();
    const agentAvatarMap = new Map<string, string | null>();
    for (const a of agents) {
      agentMap.set(a.id, a.name);
      agentAvatarMap.set(a.id, a.avatarUrl);
    }

    const threadChannelMap = new Map<string, { channelId: string; channelName: string }>();
    const threadPlatformMap = new Map<string, string>();
    for (const t of threads) {
      threadChannelMap.set(t.id, { channelId: t.channelId, channelName: t.channelName || t.channelId });
      threadPlatformMap.set(t.id, t.platform);
    }

    // Ensure thread metadata is available for ALL events, not just threads
    // explicitly linked to the work item via threads.work_item_id
    for (const evt of events) {
      if (evt.threadId && !threadPlatformMap.has(evt.threadId)) {
        const t = state.graph.getThreadById(evt.threadId);
        if (t) {
          threadChannelMap.set(t.id, { channelId: t.channelId, channelName: t.channelName || t.channelId });
          threadPlatformMap.set(t.id, t.platform);
        }
      }
    }

    // For latestBlockEvent, use all events (not paginated) to get accurate status
    const allEvents = state.graph.getEventsForWorkItem(id);
    const latestBlockEvent = allEvents
      .filter((e) => e.status === "blocked_on_human" || e.status === "needs_decision")
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0] ?? null;

    const unifiedStatus = buildUnifiedStatus(workItem, latestBlockEvent, state.operatorIdentities, agentMap);
    const timeline = buildTimeline(events, agentMap, agentAvatarMap, threadChannelMap, threadPlatformMap);

    let statusSummary: string | null = null;
    const cached = state.graph.getSummary(id);
    const latestEvent = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;
    if (cached && latestEvent && cached.latestEventId === latestEvent.id) {
      statusSummary = cached.summaryText;
    }

    // Latest thread for the reply bar (most recently active)
    const latestThread = threads.length > 0
      ? threads.reduce((a, b) =>
          new Date(a.lastActivity).getTime() >= new Date(b.lastActivity).getTime() ? a : b
        )
      : null;

    const latestEventForTarget = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;

    return c.json({
      workItem,
      unifiedStatus,
      statusSummary,
      agents: agents.map((a) => ({ id: a.id, name: a.name, avatarUrl: a.avatarUrl })),
      channels: channels.map((ch) => ({ id: ch.id, name: ch.name })),
      threadCount: threads.length,
      enrichment: enrichments[0] ?? null,
      timeline,
      hasOlder,
      latestThreadId: latestThread?.id ?? null,
      latestChannelId: latestThread?.channelId ?? null,
      targetedAtOperator: latestEventForTarget?.targetedAtOperator ?? true,
      nextAction: latestBlockEvent?.nextAction ?? null,
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
    const summarizer = new Summarizer({ baseUrl, model, apiKey, usageTracker: state.usageTracker ?? undefined });

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

  // --- GET /api/stream/all-active ---
  app.get("/api/stream/all-active", (c) => {
    const items = state.graph.getAllActiveItems();
    return c.json({ items });
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
      { baseUrl, model, apiKey, maxToolCalls: sidekickConfig.maxToolCalls, usageTracker: state.usageTracker ?? undefined },
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
        if (body.workItemId) {
          const threads = state.graph.getThreadsForWorkItem(body.workItemId);
          const thread = threads.find((t) => t.id === body.threadId);
          if (thread) {
            state.graph.insertEvent({
              threadId: body.threadId,
              messageId: `operator-reply-${Date.now()}`,
              workItemId: body.workItemId,
              agentId: null,
              status: "in_progress",
              confidence: 1.0,
              reason: "Operator reply",
              rawText: body.message,
              timestamp: new Date().toISOString(),
              entryType: "decision",
            });
          }
        }
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

  // --- POST /api/work-item/:id/pin ---
  app.post("/api/work-item/:id/pin", async (c) => {
    const { id } = c.req.param();
    if (!state.graph.getWorkItemById(id)) {
      return c.json({ ok: false, error: "Work item not found" }, 404);
    }
    const pinned = state.graph.togglePin(id);
    return c.json({ ok: true, pinned });
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

  // --- POST /api/work-item/:id/merge ---
  app.post("/api/work-item/:id/merge", async (c) => {
    const targetId = c.req.param("id");
    const body = await c.req.json<{ sourceId: string }>();
    if (!body.sourceId) {
      return c.json({ error: "Missing sourceId" }, 400);
    }
    if (!state.graph.getWorkItemById(targetId)) {
      return c.json({ error: "Target work item not found" }, 404);
    }
    if (!state.graph.getWorkItemById(body.sourceId)) {
      return c.json({ error: "Source work item not found" }, 404);
    }
    try {
      const record = state.graph.mergeWorkItems(body.sourceId, targetId);
      return c.json({ ok: true, record });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // --- POST /api/work-item/:id/unmerge ---
  app.post("/api/work-item/:id/unmerge", async (c) => {
    const sourceId = c.req.param("id");
    const source = state.graph.getWorkItemById(sourceId);
    if (!source) {
      return c.json({ error: "Work item not found" }, 404);
    }
    if (!source.mergedInto) {
      return c.json({ error: "Work item is not merged" }, 400);
    }
    try {
      state.graph.unmergeWorkItem(sourceId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // --- GET /api/work-items/search ---
  app.get("/api/work-items/search", (c) => {
    const query = c.req.query("q") ?? "";
    if (!query.trim()) {
      return c.json({ items: [] });
    }
    const items = state.graph.searchWorkItems(query)
      .filter((wi) => !wi.mergedInto)
      .map((wi) => ({
        id: wi.id,
        title: wi.title,
        currentAtcStatus: wi.currentAtcStatus,
      }));
    return c.json({ items });
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
      action: "approve" | "redirect" | "close" | "snooze" | "create_ticket" | "dismiss" | "noise";
      message?: string;
      snoozeDuration?: number;
      projectKey?: string;
    }>();

    if (!body.workItemId || !body.action) {
      return c.json({ ok: false, error: "Missing required fields: workItemId, action" }, 400);
    }

    // Find the best thread for a work item: prefer directly-linked threads,
    // fall back to the most recent thread that has events for this work item
    // (covers work items that only appear via classifier breakdowns).
    function findThreadForWorkItem(workItemId: string) {
      const direct = state.graph.getThreadsForWorkItem(workItemId);
      if (direct.length > 0) return direct[0];
      const events = state.graph.getEventsForWorkItem(workItemId);
      const withThread = [...events].reverse().find((e) => e.threadId);
      if (withThread) return state.graph.getThreadById(withThread.threadId) ?? undefined;
      return undefined;
    }

    const validActions = new Set(["approve", "redirect", "close", "snooze", "create_ticket", "dismiss", "noise"]);
    if (!validActions.has(body.action)) {
      return c.json({ ok: false, error: `Invalid action: ${body.action}` }, 400);
    }

    const workItem = state.graph.getWorkItemById(body.workItemId);
    if (!workItem) {
      return c.json({ ok: false, error: "Work item not found" }, 404);
    }

    function findThreadForWorkItem(workItemId: string) {
      const threads = state.graph.getThreadsForWorkItemViaJunction(workItemId);
      if (threads.length > 0) return threads[0];
      // Fallback: scan events (covers edge cases during migration)
      const events = state.graph.getEventsForWorkItem(workItemId);
      const withThread = [...events].reverse().find((e) => e.threadId);
      if (withThread) return state.graph.getThreadById(withThread.threadId) ?? undefined;
      return undefined;
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

        case "dismiss": {
          state.graph.dismissWorkItem(body.workItemId);
          // Insert an event recording the operator dismissal
          const dismissThread = findThreadForWorkItem(body.workItemId);
          state.graph.insertEvent({
            threadId: dismissThread?.id ?? null,
            messageId: `operator-dismiss-${Date.now()}`,
            workItemId: body.workItemId,
            agentId: null,
            status: workItem.currentAtcStatus ?? "in_progress",
            confidence: 1.0,
            reason: "Operator dismissed from stream",
            rawText: body.message ?? null,
            timestamp: new Date().toISOString(),
            entryType: "decision",
            targetedAtOperator: false,
          });
          break;
        }

        case "noise": {
          state.graph.upsertWorkItem({
            id: body.workItemId,
            source: workItem.source,
            currentAtcStatus: "noise",
          });
          const noiseThread = findThreadForWorkItem(body.workItemId);
          state.graph.insertEvent({
            threadId: noiseThread?.id ?? null,
            messageId: `operator-noise-${Date.now()}`,
            workItemId: body.workItemId,
            agentId: null,
            status: "noise",
            confidence: 1.0,
            reason: "Operator classified as noise",
            rawText: body.message ?? null,
            timestamp: new Date().toISOString(),
            entryType: "decision",
            targetedAtOperator: false,
          });
          break;
        }

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

      // Record the operator's action as an event in the timeline
      // (dismiss and noise already inserted their own events above)
      const actionThread = findThreadForWorkItem(body.workItemId);
      if (body.action !== "dismiss" && body.action !== "noise") {
        const actionStatus = body.action === "approve" || body.action === "close" ? "completed" : "in_progress";
        const actionLabels: Record<string, string> = {
          approve: "Operator approved",
          redirect: "Operator unblocked",
          close: "Operator dismissed",
          snooze: "Operator snoozed",
        };
        state.graph.insertEvent({
          threadId: actionThread?.id ?? null,
          messageId: `operator-action-${Date.now()}`,
          workItemId: body.workItemId,
          agentId: null,
          status: actionStatus,
          confidence: 1.0,
          reason: actionLabels[body.action] ?? `Operator action: ${body.action}`,
          rawText: body.message ?? null,
          timestamp: new Date().toISOString(),
          entryType: "decision",
          targetedAtOperator: false,
        });
      }

      // If there's a message and a messaging adapter, post it to the related thread
      let delivered = false;
      if (body.message && state.messagingAdapter) {
        if (actionThread) {
          await state.messagingAdapter.replyToThread(actionThread.id, actionThread.channelId, body.message);
          delivered = true;
        } else {
          log.warn("No threads found for work item — message not sent", body.workItemId);
          return c.json({ ok: false, error: "No thread found to post message to" }, 404);
        }
      }

      return c.json({ ok: true, delivered });
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

  // --- POST /api/resync ---
  app.post("/api/resync", async (c) => {
    const body = await c.req.json<{ days?: number }>().catch(() => ({}));
    const days = body.days ?? 7;
    const updated = state.graph.rollBackPollCursors(days);
    return c.json({ ok: true, cursorsRolledBack: updated, days });
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
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        dailyBudget?: number | null;
        inputCostPerMillion?: number | null;
        outputCostPerMillion?: number | null;
      };
      rateLimits?: Record<string, number>;
    }>();

    try {
      const projectRoot = findProjectRoot();
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { stringify: toYaml } = await import("yaml");

      const { readFileSync, existsSync } = await import("node:fs");
      const { parse: parseYaml } = await import("yaml");

      const configDir = resolve(projectRoot, "config");
      mkdirSync(configDir, { recursive: true });

      // Start from existing local.yaml so we don't lose fields the UI doesn't manage
      const localPath = resolve(configDir, "local.yaml");
      const localConfig: Record<string, unknown> = existsSync(localPath)
        ? (parseYaml(readFileSync(localPath, "utf-8")) as Record<string, unknown>) ?? {}
        : {};
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
        if (body.llm.apiKey) envLines.push(`WORKSTREAM_LLM_API_KEY=${body.llm.apiKey}`);
        if (body.llm.baseUrl) envLines.push(`WORKSTREAM_LLM_BASE_URL=${body.llm.baseUrl}`);
        if (body.llm.model) envLines.push(`WORKSTREAM_LLM_MODEL=${body.llm.model}`);

        // Budget config
        if (body.llm.dailyBudget !== undefined || body.llm.inputCostPerMillion !== undefined || body.llm.outputCostPerMillion !== undefined) {
          (localConfig as any).llmBudget = {
            dailyBudget: body.llm.dailyBudget ?? null,
            inputCostPerMillion: body.llm.inputCostPerMillion ?? null,
            outputCostPerMillion: body.llm.outputCostPerMillion ?? null,
          };
        }
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
        // For Jira: the base64 token goes to WORKSTREAM_JIRA_TOKEN
        if (adapterName === "jira" && prepared.token !== fields.token) {
          envLines.push(`WORKSTREAM_JIRA_TOKEN=${prepared.token}`);
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
      log.info("Wrote config/local.yaml", { model: (localConfig as any)?.classifier?.provider?.model, projectRoot });

      // Write .env (secrets only — not watched by Vite, see vite.config.ts envDir)
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
      log.info("Config reloaded", { model: state.config.classifier.provider.model, baseUrl: state.config.classifier.provider.baseUrl });

      if (state.usageTracker) {
        state.usageTracker.updateConfig(state.config.llmBudget);
      }

      // Stop existing pipeline and abort in-flight LLM calls
      if (state.pipeline) {
        state.pipeline.stop();
        state.pipeline = null;
      }
      if (state.usageTracker) {
        state.usageTracker.abort();
      }

      // Recreate rate limiters
      const rlDefaults: Record<string, { maxPerMinute: number; displayName: string }> = {
        llm: { maxPerMinute: 4, displayName: "LLM" },
        jira: { maxPerMinute: 30, displayName: "Jira" },
      };
      for (const [name, limiter] of Object.entries(state.rateLimiters)) {
        if (!rlDefaults[name]) {
          rlDefaults[name] = { maxPerMinute: limiter.limit, displayName: limiter.displayName };
        }
      }
      if (state.config.rateLimits) {
        for (const [name, cfg] of Object.entries(state.config.rateLimits)) {
          if (cfg?.maxPerMinute && !SELF_RATE_LIMITED.has(name)) {
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
        const msgIdentity = adapter.getAuthenticatedUser?.();
        if (msgIdentity) {
          state.operatorIdentities.set(adapter.name, msgIdentity);
        }
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
        const taskIdentity = adapter.getAuthenticatedUser?.();
        if (taskIdentity) {
          state.operatorIdentities.set(adapter.name, taskIdentity);
        }
        log.info("Task adapter reconnected");
      }

      // Refresh operator identities
      state.operatorIdentities.clear();
      const msgId = state.messagingAdapter?.getAuthenticatedUser?.();
      if (msgId && state.messagingAdapter) {
        state.operatorIdentities.set(state.messagingAdapter.name, msgId);
      }
      const taskId = state.taskAdapter?.getAuthenticatedUser?.();
      if (taskId && state.taskAdapter) {
        state.operatorIdentities.set(state.taskAdapter.name, taskId);
      }

      // Recreate classifier with new config, wired through a fresh UsageTracker
      const newProvider = createProvider(state.config);
      const newUsageTracker = new UsageTracker(newProvider, state.db, state.config.llmBudget);
      state.usageTracker = newUsageTracker;
      const newPrompt = loadPrompt(findProjectRoot());
      const newFewShot = buildFewShotMessages(newPrompt.few_shot_examples);
      const operatorRole = state.config.operator?.role ?? "";
      state.classifier = new Classifier(newUsageTracker, newPrompt.system, newFewShot, undefined, operatorRole, state.operatorIdentities, buildOperatorContext(state.config));
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
          state.operatorIdentities,
        );
        // Start in background — initial poll can take minutes with rate limiting
        state.pipeline.start().catch((err) => log.error("Pipeline restart failed", err));
        log.info("Pipeline restarting in background");
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
      apiKey: process.env.WORKSTREAM_LLM_API_KEY ?? "",
      baseUrl: process.env.WORKSTREAM_LLM_BASE_URL ?? "https://api.anthropic.com/v1",
      model: process.env.WORKSTREAM_LLM_MODEL ?? "claude-sonnet-4-6",
      dailyBudget: state.config.llmBudget?.dailyBudget ?? null,
      inputCostPerMillion: state.config.llmBudget?.inputCostPerMillion ?? null,
      outputCostPerMillion: state.config.llmBudget?.outputCostPerMillion ?? null,
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
  const db = new Database("workstream.db");

  // 3. Create rate limiters from config (dynamic — not hardcoded per adapter)
  const defaultRateLimits: Record<string, { maxPerMinute: number; displayName: string }> = {
    llm: { maxPerMinute: 4, displayName: "LLM" },
    jira: { maxPerMinute: 30, displayName: "Jira" },
  };
  const rateLimiters: Record<string, RateLimiter> = {};
  // Merge config overrides into defaults (skip adapters with internal rate limiting)
  if (config.rateLimits) {
    for (const [name, cfg] of Object.entries(config.rateLimits)) {
      if (cfg?.maxPerMinute && !SELF_RATE_LIMITED.has(name)) {
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
  const provider = createProvider(config);
  const usageTracker = new UsageTracker(provider, db, config.llmBudget);
  usageTracker.pruneOldRecords();

  const prompt = loadPrompt(projectRoot);
  const fewShot = buildFewShotMessages(prompt.few_shot_examples);
  const operatorRole = config.operator?.role ?? "";
  const classifier = new Classifier(usageTracker, prompt.system, fewShot, undefined, operatorRole, null, buildOperatorContext(config));
  classifier.setRateLimiter(rateLimiters.llm);
  const extractor = new DefaultExtractor({
    ticketPatterns: config.extractors.ticketPatterns,
    prPatterns: config.extractors.prPatterns,
    ticketPrefixes: config.taskAdapter.ticketPrefixes,
  });
  const linker = new WorkItemLinker(graph, [extractor]);

  // Backfill junction rows from existing events' raw_text
  graph.backfillJunctionFromRawText([extractor]);

  // Initialize engine state
  const state: EngineState = {
    config,
    db,
    graph,
    classifier,
    usageTracker,
    linker,
    pipeline: null,
    messagingAdapter: null,
    taskAdapter: null,
    rateLimiters,
    startedAt: new Date(),
    lastPoll: null,
    processed: 0,
    operatorIdentities: new Map(),
  };

  // 5. If messaging adapter configured, create and connect via registry
  // Import adapter modules so they self-register with the registry
  await import("./adapters/messaging/slack/index.js");
  await import("./adapters/tasks/jira/index.js");

  const slackToken = process.env.WORKSTREAM_SLACK_TOKEN;
  if (slackToken) {
    try {
      const adapter = createMessagingAdapter("slack");
      (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(rateLimiters.slack);
      await adapter.connect({ token: slackToken });
      state.messagingAdapter = adapter;
      const msgIdentity = adapter.getAuthenticatedUser?.();
      if (msgIdentity) {
        state.operatorIdentities.set(adapter.name, msgIdentity);
      }
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
    log.warn("No WORKSTREAM_SLACK_TOKEN set — messaging adapter disabled");
  }

  // 6. If task adapter configured, create and connect via registry
  if (config.taskAdapter.enabled && process.env.WORKSTREAM_JIRA_TOKEN) {
    try {
      const adapter = createTaskAdapter("jira");
      (adapter as { setRateLimiter?: (l: unknown) => void }).setRateLimiter?.(rateLimiters.jira);
      await adapter.connect({
        token: process.env.WORKSTREAM_JIRA_TOKEN,
        baseUrl: process.env.WORKSTREAM_JIRA_BASE_URL ?? config.taskAdapter.baseUrl ?? "",
      });
      state.taskAdapter = adapter;
      const taskIdentity = adapter.getAuthenticatedUser?.();
      if (taskIdentity) {
        state.operatorIdentities.set(adapter.name, taskIdentity);
      }
      log.info(`${adapter.displayName} adapter connected`);
    } catch (err) {
      log.error("Failed to connect task adapter", err);
    }
  }

  // 7. Create pipeline if messaging adapter is available
  if (state.messagingAdapter) {
    state.pipeline = new Pipeline(
      state.messagingAdapter,
      state.classifier,
      state.graph,
      state.linker,
      state.taskAdapter ?? undefined,
      state.config,
      state.operatorIdentities,
    );
  } else {
    log.warn("No messaging adapter available — pipeline not started (configure via POST /api/setup)");
  }

  // 8. Create and start Hono server — before pipeline polling so the server
  //    is reachable immediately (initial poll can block for minutes with rate limiting)
  const app = createApp(state);

  // Static file serving in web mode
  if (process.env.WORKSTREAM_SERVE_STATIC === "true") {
    const { serveStatic } = await import("@hono/node-server/serve-static");
    app.use("/*", serveStatic({ root: "./dist" }));
    log.info("Serving static files from ./dist/");
  }

  const { serve } = await import("@hono/node-server");
  const host = config.server.host;
  const port = config.server.port;

  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    log.info(`workstream.ai engine listening on http://${host}:${port}`);
    if (state.pipeline) {
      // Start pipeline after server is bound so the server is immediately reachable.
      // Initial poll can take minutes with rate limiting — run it in the background.
      state.pipeline.start().catch((err) => log.error("Pipeline start failed", err));
      log.info("Pipeline polling started in background");
    } else {
      log.info(`No adapters configured — visit http://${host}:${port} to set up`);
    }
  });

  // Graceful shutdown on SIGTERM / SIGINT
  function shutdown(signal: string) {
    log.info(`Received ${signal}, shutting down...`);
    state.pipeline?.stop();
    state.db.close();
    server.close(() => {
      log.info("Engine stopped cleanly");
      process.exit(0);
    });
    // Force exit after 3 seconds if something hangs
    setTimeout(() => process.exit(1), 3000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
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
