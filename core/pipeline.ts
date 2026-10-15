// core/pipeline.ts — Central orchestration loop: read → classify → link → store → enrich

import { createHash } from "node:crypto";
import { createLogger } from "./logger.js";
import type { Config } from "./config.js";
import type { Classification, Message, OperatorIdentityMap, Thread, ThreadContext } from "./types.js";
import type { MessagingAdapter } from "./adapters/messaging/interface.js";
import type { TaskAdapter } from "./adapters/tasks/interface.js";
import type { Classifier } from "./classifier/index.js";
import type { ContextGraph } from "./graph/index.js";
import type { WorkItemLinker } from "./graph/linker.js";
import { looksLikeTicketKey } from "./graph/extractors/default.js";

const log = createLogger("pipeline");

/** Thrown inside a poll that stop() has superseded, so it unwinds without storing anything. */
class PipelineStopped extends Error {}

/** Thrown when the model gave no answer for a message; nothing is stored and the message is tried again. */
class ClassificationFailed extends Error {
  constructor(readonly kind: "invalid" | "unreachable" | "auth" | "budget") {
    super(`Classification failed (${kind})`);
  }
}

/**
 * A message whose classification keeps failing is stored as noise after this many counted tries, so it can't hold
 * its channel back forever. An unusable reply always counts; "couldn't reach the model" counts only when other
 * messages got real answers in the same poll, so an outage doesn't use up tries.
 */
const MAX_CLASSIFY_ATTEMPTS = 3;
/** However the tries go, a message isn't held back for longer than this. */
const MAX_HOLD_MS = 6 * 60 * 60 * 1000;
/** Retries back off (next poll, then 30s, 1m, 2m … up to 30m), which bounds the calls a held message costs. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60 * 1000;

/** While the model looks unavailable, read the platform no more often than this (new messages wait at most this) */
const OUTAGE_READ_MAX_WAIT_MS = 60 * 1000;

/** After the provider refuses the credentials, try again this often (a settings save resumes at once) */
const AUTH_PAUSE_MS = 5 * 60 * 1000;

function retryDelay(attempts: number): number {
  return attempts <= 1 ? 0 : Math.min(RETRY_BASE_MS * 2 ** (attempts - 2), RETRY_MAX_MS);
}

function nextUtcMidnight(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

const DEFAULT_POLL_INTERVAL = 30;
const DEFAULT_LOOKBACK_DAYS = 1;
const DEFAULT_MAX_THREADS_PER_POLL = 50;
const DEFAULT_MAX_ACTIVE_THREAD_REPOLLS = 20;
/** Earlier thread messages shown to the classifier with each new message. */
const THREAD_CONTEXT_MESSAGES = 4;

export interface ProcessResult {
  processed: number;
  classified: number;
  errors: number;
}

export class Pipeline {
  private catchUpLogged = false;
  private messagingAdapter: MessagingAdapter;
  private classifier: Classifier;
  private graph: ContextGraph;
  private linker: WorkItemLinker;
  private taskAdapter?: TaskAdapter;
  private config?: Config;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private recentContentHashes = new Map<string, Classification>();
  private readonly MAX_CONTENT_HASHES = 1000;
  private operatorIdentities: OperatorIdentityMap | null = null;
  private validPrefixes: string[] | null = null;
  /** Advanced by start() and stop(); a poll that sees it change has been superseded and stops. */
  private runId = 0;
  /** Messages (`threadId:messageId`) whose classification failed, cleared once one is stored. */
  private failedMessages = new Map<string, { tries: number; attempts: number; since: number; nextTryAt: number }>();
  /** Real model answers this poll: evidence the model is up when deciding whether a failed try counts. */
  private answeredThisPoll = 0;
  /**
   * Polling (and its Slack reads) pauses after the daily budget runs out, until it resets, and for a few minutes
   * after the provider refuses the credentials (a settings save builds a new pipeline, so a fix applies at once).
   */
  private pausedUntil = 0;
  private pausedFor: "budget" | "auth" | null = null;
  /** The last poll had failures and no real model answers */
  private modelUnavailable = false;
  /** During such an outage, skip platform reads until the earliest held message is due for a retry */
  private outageReadsAfter = 0;

  constructor(
    messagingAdapter: MessagingAdapter,
    classifier: Classifier,
    graph: ContextGraph,
    linker: WorkItemLinker,
    taskAdapter?: TaskAdapter,
    config?: Config,
    operatorIdentities?: OperatorIdentityMap,
  ) {
    this.messagingAdapter = messagingAdapter;
    this.classifier = classifier;
    this.graph = graph;
    this.linker = linker;
    this.taskAdapter = taskAdapter;
    this.config = config;
    this.operatorIdentities = operatorIdentities ?? null;
  }

  /** Why classification is paused right now, if it is: shown as a degraded model status */
  pauseReason(): "budget" | "auth" | null {
    return Date.now() < this.pausedUntil ? this.pausedFor : null;
  }

  /** Whether this message has failed more than once, so later messages in its thread go ahead without it */
  private failedRepeatedly(message: Message, thread: Thread): boolean {
    return (this.failedMessages.get(`${thread.id}:${message.id}`)?.attempts ?? 0) >= 2;
  }

  /** Whether the last poll got failures and no real model answers (an outage, or an account-wide refusal) */
  isModelUnavailable(): boolean {
    return this.modelUnavailable;
  }

  /** Settings read at each poll (inbox) take effect from the next one, without a restart. */
  setConfig(config: Config): void {
    this.config = config;
  }

  /** True once the first poll has finished and the polling timer is set; false if start() failed or stop() ran. */
  isPolling(): boolean {
    return this.intervalHandle !== null;
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn("Pipeline already running");
      return;
    }
    this.running = true;
    const run = ++this.runId;

    log.info("Pipeline starting");

    // Run once immediately
    const result = await this.processOnce();
    log.info("Initial poll complete", result);
    // stop() during that first poll (a settings save restarts the pipeline) means no polling timer
    if (run !== this.runId) return;

    // Set up the polling interval
    const intervalSeconds = this.config?.messaging?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    // A catch-up poll can outlast the interval; overlapping polls multiply Slack calls into rate limits.
    this.intervalHandle = setInterval(async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const r = await this.processOnce();
        log.info("Poll complete", r);
      } catch (err) {
        log.error("Poll cycle failed", err);
      } finally {
        this.polling = false;
      }
    }, intervalSeconds * 1000);

    log.info(`Polling every ${intervalSeconds}s`);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    this.runId++;
    this.modelUnavailable = false;
    this.outageReadsAfter = 0;
    log.info("Pipeline stopped");
  }

  async processOnce(): Promise<ProcessResult> {
    const channels = this.config?.messaging?.channels ?? [];
    let processed = 0;
    let classified = 0;
    let errors = 0;
    // After stop(), make no more platform or model calls and write nothing more: a settings save may have
    // just rotated the credentials or moved the model endpoint this poll was started with
    const run = this.runId;
    const stopped = () => run !== this.runId;
    if (Date.now() < this.pausedUntil || (this.modelUnavailable && Date.now() < this.outageReadsAfter)) {
      this.expireInactiveItems();
      return { processed, classified, errors };
    }
    const failedThisPoll: string[] = [];
    this.answeredThisPoll = 0;

    // Build per-channel cursors from the database
    const { globalSince, perChannelSince } = this.getPerChannelSince();

    let threads: Thread[];
    try {
      threads = await this.messagingAdapter.readThreads(
        globalSince,
        channels.length > 0 ? channels : undefined,
        perChannelSince.size > 0 ? perChannelSince : undefined,
      );
    } catch (err) {
      log.error("Failed to read threads from messaging adapter", err);
      return { processed: 0, classified: 0, errors: 1 };
    }
    if (stopped()) return { processed, classified, errors };

    // Track latest timestamp per channel for cursor updates
    const latestTimestamps = new Map<string, string>();
    // Channels with a message to retry: the cursor stays before that thread
    const heldBack = new Map<string, string | null>();
    let paused = false;

    // Cap threads per poll to avoid LLM call bursts
    const maxThreads = this.config?.lookback?.maxThreadsPerPoll ?? DEFAULT_MAX_THREADS_PER_POLL;
    // Oldest first, then cap: adapters return newest first, and capping before sorting dropped the oldest
    // threads behind a cursor that had already moved past them.
    const threadStart = (t: Thread) => t.messages[0]?.timestamp ?? t.lastActivity;
    // Threads with every message already classified (re-read at a cursor boundary) don't take a slot.
    const pendingKey = new Map<Thread, string>();
    for (const t of threads) {
      const m = t.messages.find((msg) => !this.graph.hasEvent(msg.id, t.id));
      if (m) pendingKey.set(t, `${t.id}:${m.id}`);
    }
    const pendingThreads = [...pendingKey.keys()].sort((a, b) => threadStart(a).localeCompare(threadStart(b)));
    // A thread whose message is backing off from a failure doesn't take a slot this poll; fresh threads go before
    // retries, so held messages can't crowd out new ones. Threads not processed keep their channel's cursor.
    const pollStart = Date.now();
    const waitingThreads = pendingThreads.filter((t) => (this.failedMessages.get(pendingKey.get(t)!)?.nextTryAt ?? 0) > pollStart);
    const ready = pendingThreads.filter((t) => !waitingThreads.includes(t));
    const isRetry = (t: Thread) => this.failedMessages.has(pendingKey.get(t)!);
    const sortedThreads = [...ready.filter((t) => !isRetry(t)), ...ready.filter(isRetry)];
    const cappedThreads = maxThreads > 0 ? sortedThreads.slice(0, maxThreads) : sortedThreads;

    // Channels with threads left for a later poll: their cursor must stay before the first one skipped.
    const deferredChannels = new Set(sortedThreads.slice(cappedThreads.length).map((t) => t.channelId));

    if (sortedThreads.length > cappedThreads.length) {
      log.info(`Capped threads with new messages from ${sortedThreads.length} to ${cappedThreads.length} (maxThreadsPerPoll=${maxThreads})`);
    }

    // Track thread IDs covered by this channel history poll
    const polledThreadIds = new Set<string>();

    // Keep a channel's cursor just before a thread that has to be read again
    const holdBack = (t: Thread) => {
      const before = Date.parse(threadStart(t)) - 1;
      const prior = heldBack.get(t.channelId);
      const at = Number.isNaN(before) ? null : new Date(before).toISOString();
      heldBack.set(t.channelId, prior === undefined ? at : prior === null || at === null ? null : prior < at ? prior : at);
    };

    for (const t of [...waitingThreads, ...sortedThreads.slice(cappedThreads.length)]) holdBack(t);

    for (const [index, thread] of cappedThreads.entries()) {
      if (stopped()) break;
      if (!thread.messages || thread.messages.length === 0) {
        continue;
      }

      polledThreadIds.add(thread.id);

      // Process ALL unprocessed messages in order (oldest → newest), not just
      // the latest.  The hasEvent() check inside processMessageInternal is a
      // cheap DB lookup and will skip already-processed messages without an
      // LLM call.  Processing every message ensures intermediate work-item
      // references and status transitions are captured.
      let held = false;
      for (const message of thread.messages) {
        if (stopped()) break;
        if (this.graph.hasEvent(message.id, thread.id)) {
          continue; // already classified — skip cheaply
        }
        processed++;
        try {
          const outcome = await this.classifyPending(message, thread, stopped, failedThisPoll);
          if (outcome === "done") {
            classified++;
            continue;
          }
          if (outcome !== "waiting") errors++;
          held = true;
          if (outcome === "paused") paused = true;
          // Later messages wait so they're classified in order, but only behind a first failure: a message that
          // keeps failing (or a crafted reply) mustn't hide the rest of its thread for hours
          if (outcome === "paused" || !this.failedRepeatedly(message, thread)) break;
        } catch (err) {
          if (err instanceof PipelineStopped) break;
          log.error("Failed to process message", message.id, err);
          errors++;
        }
      }
      // A thread cut short doesn't move its channel's cursor; the next pipeline reads it again
      if (stopped()) break;

      const channelId = thread.channelId;
      if (held) {
        holdBack(thread);
        if (paused) {
          // Threads not reached this poll must be read again too, whatever channel they're in
          for (const rest of cappedThreads.slice(index + 1)) holdBack(rest);
          break;
        }
        continue;
      }

      // Track the latest timestamp for poll cursor updates
      // (a deferred channel advances only to this thread's start; later replies come back via re-polls)
      const cursorTs = deferredChannels.has(channelId)
        ? threadStart(thread)
        : thread.messages[thread.messages.length - 1].timestamp;
      const existing = latestTimestamps.get(channelId);
      if (!existing || cursorTs > existing) {
        latestTimestamps.set(channelId, cursorTs);
      }
    }

    if (stopped()) return { processed, classified, errors };

    // A channel with a thread to retry doesn't move past it (null: its start time is unknown, so don't move)
    for (const [channelId, at] of heldBack) {
      const latest = latestTimestamps.get(channelId);
      if (at === null) latestTimestamps.delete(channelId);
      else if (!latest || at < latest) latestTimestamps.set(channelId, at);
    }

    // Update poll cursors
    for (const [channelId, timestamp] of latestTimestamps) {
      try {
        this.graph.setPollCursor(channelId, timestamp);
      } catch (err) {
        log.error("Failed to update poll cursor", channelId, err);
      }
    }

    // --- Re-poll active threads for new replies ---
    // Threads whose parent message is older than the poll cursor won't appear
    // in conversations.history, but they can still receive new replies.
    // Re-fetch replies for known active threads that weren't already covered.
    const maxRepolls = this.config?.lookback?.maxActiveThreadRepolls ?? DEFAULT_MAX_ACTIVE_THREAD_REPOLLS;
    if (maxRepolls > 0 && !paused) {
      const activeThreads = this.graph.getActiveThreads(maxRepolls);
      let repolled = 0;

      for (const activeThread of activeThreads) {
        if (stopped() || paused) break;
        if (polledThreadIds.has(activeThread.id)) continue; // already covered

        try {
          const messages = await this.messagingAdapter.getThreadMessages(
            activeThread.id,
            activeThread.channelId,
          );
          if (messages.length === 0) continue;

          // Build a Thread object for processing
          const threadObj: Thread = {
            id: activeThread.id,
            channelId: activeThread.channelId,
            channelName: activeThread.channelName,
            platform: activeThread.platform,
            workItemId: activeThread.workItemId,
            lastActivity: messages[messages.length - 1].timestamp,
            messageCount: messages.length,
            messages,
          };

          // Process only unprocessed messages
          let hadNew = false;
          for (const msg of messages) {
            if (stopped()) break;
            if (this.graph.hasEvent(msg.id, activeThread.id)) continue;
            hadNew = true;
            processed++;
            try {
              const outcome = await this.classifyPending(msg, threadObj, stopped, failedThisPoll);
              if (outcome === "done") {
                classified++;
                continue;
              }
              // No cursor here: an active thread is fetched again on the next poll
              if (outcome !== "waiting") errors++;
              if (outcome === "paused") paused = true;
              if (outcome === "paused" || !this.failedRepeatedly(msg, threadObj)) break;
            } catch (err) {
              if (err instanceof PipelineStopped) break;
              log.error("Failed to process re-polled message", msg.id, err);
              errors++;
            }
          }

          if (hadNew) repolled++;
        } catch (err) {
          log.error("Failed to re-poll active thread", activeThread.id, err);
          errors++;
        }
      }

      if (repolled > 0) {
        log.info(`Re-polled ${repolled} active threads with new messages`);
      }
    }

    if (stopped()) return { processed, classified, errors };

    // A failed try counts only if other messages were classified this poll: the model is up, so the message is
    // the problem. During an outage nothing counts, and messages wait for the model to come back.
    // Failures and not one real answer: the model looks unavailable (shown as a degraded status)
    // Only a poll that tried something says anything about the model; one where every held message was still
    // backing off keeps the previous verdict (and its read gate)
    if (failedThisPoll.length > 0 || this.answeredThisPoll > 0) {
      this.modelUnavailable = failedThisPoll.length > 0 && this.answeredThisPoll === 0;
    } else if (this.modelUnavailable && ![...this.failedMessages.values()].some((r) => r.nextTryAt > Date.now())) {
      this.modelUnavailable = false; // nothing is held any more (deleted, or given up): no evidence of an outage
    }
    if (this.modelUnavailable) {
      // Nothing could be classified: re-reading the platform before a held message is due again (up to 30 min
      // with backoff) only costs reads and rate limit. Gate only while several messages are held, so a single
      // message that keeps failing doesn't delay new ones (an outage that has held just one message so far is read
      // every poll); capped, so a new message waits at most a minute.
      const now = Date.now();
      let earliest = now + OUTAGE_READ_MAX_WAIT_MS;
      let held = 0;
      for (const rec of this.failedMessages.values()) {
        if (rec.nextTryAt <= now) continue; // stale: a message deleted, or no longer re-polled
        held++;
        earliest = Math.min(earliest, rec.nextTryAt);
      }
      this.outageReadsAfter = held >= 2 ? earliest : 0;
    }
    if (this.answeredThisPoll > 0) {
      for (const key of failedThisPoll) {
        const rec = this.failedMessages.get(key);
        if (rec) rec.tries++;
      }
    }

    // Recompute bot types after processing — more data may refine classifications
    if (processed > 0) {
      this.graph.computeBotTypes();
    }

    this.expireInactiveItems();

    return { processed, classified, errors };
  }

  /** Optional: auto-dismiss Needs-me items nobody has written about for inbox.expireAfterDays */
  private expireInactiveItems(): void {
    const expireAfterDays = this.config?.inbox?.expireAfterDays;
    if (!expireAfterDays) return;
    try {
      const expired = this.graph.expireInactiveItems(expireAfterDays);
      if (expired > 0) log.info(`Auto-dismissed ${expired} item(s) with no activity for ${expireAfterDays} day(s)`);
    } catch (err) {
      log.error("Failed to expire inactive items", err);
    }
  }

  async processMessage(message: Message, threadId: string, channelId: string): Promise<Classification> {
    // Upsert the thread first so the linker can find it
    this.graph.upsertThread({
      id: threadId,
      channelId,
      channelName: message.channelName ?? "",
      platform: message.platform,
      lastActivity: message.timestamp,
      messageCount: 1,
    });

    const thread: Thread = {
      id: threadId,
      channelId,
      channelName: message.channelName ?? "",
      platform: message.platform,
      workItemId: null,
      lastActivity: message.timestamp,
      messageCount: 1,
      messages: [message],
    };

    return this.processMessageInternal(message, thread);
  }

  // --- Private helpers ---

  private getValidPrefixes(): string[] {
    if (this.validPrefixes !== null) return this.validPrefixes;

    // Prefer task adapter's runtime prefixes (e.g. from Jira project list)
    if (this.taskAdapter?.getValidIdPrefixes) {
      this.validPrefixes = this.taskAdapter.getValidIdPrefixes().map(p => p.toUpperCase());
    } else {
      // Fall back to static config
      this.validPrefixes = (this.config?.taskAdapter?.ticketPrefixes ?? []).map(p => p.toUpperCase());
    }
    return this.validPrefixes;
  }

  /**
   * The operator's own message is never something the operator has to act on: they just acted, so the
   * next move is someone else's. Without this, "any news on this?" came back blocked and targeted, and
   * kept the item in the operator's inbox with their own message as the reason.
   */
  private fromOperator(message: Message, classification: Classification): Classification {
    const operatorIds = new Set([...(this.operatorIdentities?.values() ?? [])].map((id) => id.userId));
    if (!operatorIds.has(message.userId)) return classification;
    // "@Dana please approve X" from the operator is still blocked — on Dana. Keep that status; just untarget it.
    const namesSomeoneElse = (classification.actionRequiredFrom ?? []).some((id) => !operatorIds.has(id));
    const waitingOnOperator =
      (classification.status === "blocked_on_human" || classification.status === "needs_decision") && !namesSomeoneElse;
    return {
      ...classification,
      targetedAtOperator: false,
      ...(waitingOnOperator
        ? {
            status: "in_progress" as const,
            entryType: classification.entryType === "block" ? "progress" as const : classification.entryType,
            reason: `${classification.reason} [operator's own message: not waiting on the operator]`,
          }
        : {}),
    };
  }

  private isValidWorkItemId(id: string): boolean {
    // Also allow synthetic IDs (thread:xxx), and any work item that already exists (e.g. one an agent created over
    // MCP as "deploy-payments"): the prompt offers those as candidates
    if (id.startsWith("thread:") || this.graph.getWorkItemById(id)) return true;
    const prefixes = this.getValidPrefixes();
    // No prefixes configured: accept a ticket key (but not a technical term like UTF-8) or a pull request
    if (prefixes.length === 0) return looksLikeTicketKey(id) || /^PR\s*#?\d+$/i.test(id);
    return prefixes.some(prefix => id.toUpperCase().startsWith(prefix));
  }

  /**
   * Classify and store one polled message. "held": the model gave no answer, so nothing was stored and the
   * message is tried again later; after MAX_CLASSIFY_ATTEMPTS counted tries, or once it has been held for
   * MAX_HOLD_MS, it's stored as noise instead. "waiting": still backing off from a failure, so not tried.
   * "paused": the budget is spent or the credentials were refused, and the poll should stop here.
   */
  private async classifyPending(
    message: Message,
    thread: Thread,
    stopped: () => boolean,
    failedThisPoll: string[],
  ): Promise<"done" | "held" | "waiting" | "paused"> {
    const key = `${thread.id}:${message.id}`;
    const now = Date.now();
    const rec = this.failedMessages.get(key);
    if (rec && now < rec.nextTryAt) return "waiting"; // backing off: no model call this poll
    const giveUp = rec !== undefined && (rec.tries >= MAX_CLASSIFY_ATTEMPTS || now - rec.since > MAX_HOLD_MS);
    try {
      await this.processMessageInternal(message, thread, stopped, giveUp);
      this.failedMessages.delete(key);
      return "done";
    } catch (err) {
      if (!(err instanceof ClassificationFailed)) throw err;
      if (err.kind === "budget" || err.kind === "auth") {
        this.pausedFor = err.kind;
        this.pausedUntil = err.kind === "budget" ? nextUtcMidnight() : now + AUTH_PAUSE_MS;
        log.warn(err.kind === "budget"
          ? `Daily LLM budget spent; classification is paused until ${new Date(this.pausedUntil).toISOString()}`
          : "The model provider refused the API key or account; classification is paused. Check Settings.");
        return "paused";
      }
      // Entries for messages that vanished before a retry
      if (this.failedMessages.size > 10_000) this.failedMessages.clear();
      const r = rec ?? { tries: 0, attempts: 0, since: now, nextTryAt: 0 };
      r.attempts++;
      r.nextTryAt = now + retryDelay(r.attempts);
      if (err.kind === "invalid") r.tries++;
      else failedThisPoll.push(key); // counted at the end of the poll if the model answered anything else
      this.failedMessages.set(key, r);
      log.warn(`Classification failed for ${message.id} (${err.kind}); trying again later`);
      return "held";
    }
  }

  private getContentHash(text: string, threadId: string): string {
    return createHash("sha256").update(`${threadId}:${text}`).digest("hex");
  }

  private getPerChannelSince(): { globalSince: Date; perChannelSince: Map<string, Date> } {
    // Build a per-channel cursor map from the database.
    // Channels with a stored cursor use their own timestamp.
    // Channels without a cursor use the global fallback (initialDays lookback).
    const lookbackDays = this.config?.lookback?.initialDays ?? DEFAULT_LOOKBACK_DAYS;
    const globalSince = new Date();
    globalSince.setDate(globalSince.getDate() - lookbackDays);

    // After a long pause (app closed for weeks), don't replay everything since the old cursor: those
    // messages are stale, and classifying them floods the inbox with long-resolved "blocks".
    const catchUpDays = this.config?.lookback?.maxCatchUpDays ?? lookbackDays;
    const catchUpFloor = new Date();
    catchUpFloor.setDate(catchUpFloor.getDate() - catchUpDays);

    const allCursors = this.graph.getAllPollCursors();
    const perChannelSince = new Map<string, Date>();
    let clamped = 0;

    for (const cursor of allCursors) {
      const since = new Date(cursor.lastTimestamp);
      if (since < catchUpFloor) clamped++;
      perChannelSince.set(cursor.channelId, since < catchUpFloor ? catchUpFloor : since);
    }
    if (clamped > 0 && !this.catchUpLogged) {
      this.catchUpLogged = true;
      log.info(`${clamped} channel cursor(s) older than ${catchUpDays} day(s) — catching up from ${catchUpFloor.toISOString()} only`);
    }

    return { globalSince, perChannelSince };
  }

  private async processMessageInternal(
    message: Message,
    thread: Thread,
    stopped: () => boolean = () => false,
    storeFailure = true,
  ): Promise<Classification> {
    // Step 0: Skip if we've already processed this message (avoids duplicate LLM calls)
    if (this.graph.hasEvent(message.id, thread.id)) {
      log.debug("Skipping already-processed message", message.id);
      const existing = this.graph.getEventByMessageId(message.id, thread.id)!;
      return {
        status: existing.status as Classification["status"],
        entryType: existing.entryType,
        confidence: existing.confidence,
        reason: existing.reason,
        workItemIds: existing.workItemId ? [existing.workItemId] : [],
        title: "",
        targetedAtOperator: existing.targetedAtOperator,
        actionRequiredFrom: existing.actionRequiredFrom,
        nextAction: existing.nextAction,
      };
    }

    // Step 0b: Inherit work item from existing thread (if already linked)
    const existingThread = this.graph.getThreadById(thread.id);
    const inheritedWorkItemId = existingThread?.workItemId ?? null;
    const allWorkItemIds = new Set<string>();
    if (inheritedWorkItemId) {
      allWorkItemIds.add(inheritedWorkItemId);
    } else if (message.senderType !== "human" && thread.messages[0]?.id === message.id) {
      // Step 0b': a bot re-posting the same alert as a new top-level message joins the open item
      const recurringId = this.graph.findRecurringWorkItem({
        agentId: message.userId,
        channelId: thread.channelId,
        text: message.text,
        before: message.timestamp,
      });
      if (recurringId) {
        log.debug("Recurring alert joins existing work item", recurringId, thread.id);
        allWorkItemIds.add(recurringId);
      }
    }

    // Step 0c: Skip classification if the work item is already completed
    if (inheritedWorkItemId) {
      const existingWI = this.graph.getWorkItemById(inheritedWorkItemId);
      if (existingWI?.currentAtcStatus === "completed") {
        log.debug("Skipping classification for completed work item", inheritedWorkItemId);
        // Still record the event so the message isn't lost
        this.graph.upsertAgent({
          id: message.userId,
          name: message.userName,
          platform: message.platform,
          platformUserId: message.userId,
          avatarUrl: message.userAvatarUrl ?? null,
          isBot: message.senderType === "agent" ? true : message.senderType === "human" ? false : null,
        });
        this.graph.insertEvent({
          threadId: thread.id,
          messageId: message.id,
          workItemId: inheritedWorkItemId,
          agentId: message.userId,
          status: "noise",
          confidence: 0,
          reason: "Work item already completed — skipping classification",
          rawText: message.text,
          timestamp: message.timestamp,
          actionRequiredFrom: null,
          nextAction: null,
        });
        return {
          status: "noise",
          entryType: "noise" as const,
          confidence: 0,
          reason: "Work item already completed — skipping classification",
          workItemIds: [inheritedWorkItemId],
          title: "",
          targetedAtOperator: false,
          actionRequiredFrom: null,
          nextAction: null,
        };
      }
    }

    // Step 0d: Skip classification for duplicate message content
    const contentHash = this.getContentHash(message.text, thread.id);
    if (this.recentContentHashes.has(contentHash)) {
      log.debug("Skipping duplicate message content", message.id);
      const cachedResult = this.recentContentHashes.get(contentHash)!;
      this.graph.upsertAgent({
        id: message.userId,
        name: message.userName,
        platform: message.platform,
        platformUserId: message.userId,
        avatarUrl: message.userAvatarUrl ?? null,
        isBot: message.senderType === "agent" ? true : message.senderType === "human" ? false : null,
      });
      this.graph.insertEvent({
        threadId: thread.id,
        messageId: message.id,
        workItemId: inheritedWorkItemId,
        agentId: message.userId,
        status: cachedResult.status,
        confidence: cachedResult.confidence,
        reason: cachedResult.reason + " (deduplicated)",
        rawText: message.text,
        timestamp: message.timestamp,
        actionRequiredFrom: cachedResult.actionRequiredFrom,
        nextAction: cachedResult.nextAction,
      });
      return cachedResult;
    }

    // Step 0e: Find candidate work items via graph scoring (replaces brute-force 100-item dump)
    const candidates = this.graph.findCandidateWorkItems({
      agentId: message.userId,
      channelId: thread.channelId,
      messageText: message.text,
    });
    // Format candidates for the classifier: ranked list with reasons
    const candidateContext = candidates.map(c => ({
      id: c.id,
      title: c.title,
      reasons: c.reasons,
    }));

    // Step 0f: Gather recent channel context for continuation detection.
    // Only for standalone (non-threaded) messages — threaded messages are already
    // grouped by Slack's native threading.
    const isStandaloneMessage = thread.messages.length <= 1;
    const continuationConfig = this.config?.continuation;
    const channelContext = isStandaloneMessage
      ? this.graph.getRecentChannelContext({
          channelId: thread.channelId,
          windowMinutes: continuationConfig?.channelContextWindow ?? 30,
          limit: continuationConfig?.maxContextMessages ?? 5,
          excludeThreadId: thread.id,
          before: message.timestamp,
        })
      : [];

    // Step 0g: Ensure the thread row exists before the linker writes junction
    // rows (thread_work_items has a FK on threads.id).
    if (!existingThread) {
      this.graph.upsertThread({
        id: thread.id,
        channelId: thread.channelId,
        channelName: thread.channelName,
        platformMeta: thread.platformMeta,
        platform: thread.platform,
        lastActivity: message.timestamp,
        messageCount: thread.messages.length,
      });
    }

    // Step 1: Link work items from message text (regex — only known prefixes)
    const extractedIds = this.linker.linkMessage(message.text, thread.id);

    // Step 2: Classify the message with operator identities and sender context
    // Override senderType if the graph has classified this bot as a notification source
    let effectiveSenderType = message.senderType ?? "unknown";
    if (effectiveSenderType === "agent") {
      const botType = this.graph.getBotType(message.userId);
      if (botType === "notification") {
        effectiveSenderType = "notification";
      }
    }
    const senderContext = {
      senderName: message.userName,
      senderType: effectiveSenderType,
      channelName: message.channelName,
    };
    // Step 0h: Thread context — what this message is a reply to. Without it, "approved, go ahead" is unreadable.
    const threadWorkItem = inheritedWorkItemId ? this.graph.getWorkItemById(inheritedWorkItemId) : null;
    const threadContext: ThreadContext = {
      workItem: threadWorkItem
        ? { id: threadWorkItem.id, title: threadWorkItem.title, status: threadWorkItem.externalStatus }
        : undefined,
      messages: thread.messages
        .filter((m) => m.id !== message.id && m.timestamp < message.timestamp && m.text.trim())
        .slice(-THREAD_CONTEXT_MESSAGES)
        .map((m) => ({ senderName: m.userName, text: m.text })),
    };
    const classification = this.fromOperator(
      message,
      await this.classifier.classify(message.text, candidateContext, this.operatorIdentities, senderContext, this.getValidPrefixes(), channelContext, threadContext),
    );
    // Stopped while classifying: the call may have been cut off and come back as a fallback, so store
    // nothing and leave the message for the next pipeline to classify
    if (stopped()) throw new PipelineStopped();
    // No answer from the model: store nothing so the message is tried again, unless this was the last try
    // (a spent budget is never stored: it resets)
    if (!classification.failed) this.answeredThisPoll++;
    if (classification.failed && !(storeFailure && (classification.failed === "invalid" || classification.failed === "unreachable"))) {
      throw new ClassificationFailed(classification.failed);
    }

    // Separate LLM-suggested IDs into verified (match an extracted ID) and unverified
    const extractedSet = new Set(extractedIds);
    // Add extracted IDs to allWorkItemIds
    for (const id of extractedIds) {
      allWorkItemIds.add(id);
    }

    for (const llmId of classification.workItemIds) {
      if (!extractedSet.has(llmId)) {
        // LLM suggested an ID that the regex didn't find — validate before creating
        if (!this.isValidWorkItemId(llmId)) {
          log.debug("Discarding LLM-suggested ID that doesn't match known prefixes:", llmId);
          continue;
        }
        this.graph.upsertWorkItem({
          id: llmId,
          source: "inferred",
          title: classification.title || llmId,
        });
      }
      allWorkItemIds.add(llmId);
    }

    // Cache the classification for content deduplication
    const hash = this.getContentHash(message.text, thread.id);
    // A stored placeholder isn't an answer to reuse for the same text later
    if (!classification.failed) this.recentContentHashes.set(hash, classification);
    if (this.recentContentHashes.size > this.MAX_CONTENT_HASHES) {
      const firstKey = this.recentContentHashes.keys().next().value;
      if (firstKey) this.recentContentHashes.delete(firstKey);
    }

    // Step 2b: If no work item IDs found and this isn't noise, create a synthetic work item
    // keyed by thread ID so the conversation stays grouped under one item
    if (allWorkItemIds.size === 0 && classification.status !== "noise") {
      const syntheticId = `thread:${thread.id}`;
      // A message classified late (held for a retry) mustn't overwrite the state a newer message already set
      if (!this.graph.getWorkItemById(syntheticId) || !this.graph.hasNewerEvent(syntheticId, thread.id, message.timestamp)) {
        this.graph.upsertWorkItem({
          id: syntheticId,
          source: "inferred",
          title: classification.title || "Untitled conversation",
          currentAtcStatus: classification.status,
          currentConfidence: classification.confidence,
        });
      }
      allWorkItemIds.add(syntheticId);
      log.debug("Created synthetic work item for unticketed thread", syntheticId, classification.title);
    }

    // Step 3: Upsert agent
    const agent = this.graph.upsertAgent({
      id: message.userId,
      name: message.userName,
      platform: message.platform,
      platformUserId: message.userId,
      avatarUrl: message.userAvatarUrl ?? null,
      isBot: message.senderType === "agent" ? true : message.senderType === "human" ? false : null,
    });

    // Step 4: Upsert thread in graph — preserve manually linked work items
    const isManuallyLinked = existingThread?.manuallyLinked === true;
    const primaryWorkItemId = allWorkItemIds.size > 0 ? [...allWorkItemIds][0] : null;

    this.graph.upsertThread({
      id: thread.id,
      channelId: thread.channelId,
      channelName: thread.channelName,
      platformMeta: thread.platformMeta,
      platform: thread.platform,
      workItemId: isManuallyLinked ? existingThread!.workItemId : primaryWorkItemId,
      // Never backwards: a message classified late (held for a retry) is older than what's already recorded
      lastActivity: existingThread?.lastActivity && existingThread.lastActivity > message.timestamp
        ? existingThread.lastActivity
        : message.timestamp,
      messageCount: thread.messages.length,
    });

    // Step 5: Insert event with classification
    this.graph.insertEvent({
      threadId: thread.id,
      messageId: message.id,
      workItemId: primaryWorkItemId,
      agentId: agent.id,
      status: classification.status,
      entryType: classification.entryType,
      confidence: classification.confidence,
      reason: classification.reason,
      rawText: message.text,
      timestamp: message.timestamp,
      targetedAtOperator: classification.targetedAtOperator,
      actionRequiredFrom: classification.actionRequiredFrom,
      nextAction: classification.nextAction,
    });

    // Step 6: Update work item status and write junction rows
    const validatedBreakdownMap = new Map(
      (classification.breakdown ?? [])
        .filter((b) => allWorkItemIds.has(b.workItemId))
        .map((b) => [b.workItemId, b]),
    );

    for (const workItemId of allWorkItemIds) {
      // Write junction row (primary for the first/inherited ID, mentioned for the rest)
      const relation = workItemId === primaryWorkItemId ? "primary" : "mentioned";
      this.graph.linkThreadWorkItem(thread.id, workItemId, relation);

      const existing = this.graph.getWorkItemById(workItemId);
      if (existing) {
        const itemClassification = validatedBreakdownMap.get(workItemId);

        // Only the primary work item inherits the thread-level classification.
        // Mentioned items must have an explicit breakdown entry — otherwise we
        // skip the status update.  This prevents a planning/summary thread's
        // top-level status (e.g. "needs_decision") from bleeding into every
        // ticket that happened to be listed in the message.
        if (!itemClassification && relation === "mentioned") {
          continue;
        }

        const itemStatus = itemClassification?.status ?? classification.status;
        const itemConfidence = itemClassification?.confidence ?? classification.confidence;
        const itemTitle = itemClassification?.title ?? classification.title;

        // A message classified late (held for a retry) doesn't overwrite the status a newer message already set
        const shouldUpdate =
          (!existing.currentConfidence || itemConfidence >= existing.currentConfidence) &&
          !this.graph.hasNewerEvent(workItemId, thread.id, message.timestamp);

        if (shouldUpdate) {
          this.graph.upsertWorkItem({
            id: workItemId,
            source: existing.source,
            currentAtcStatus: itemStatus,
            currentConfidence: itemConfidence,
            // Set LLM title if work item has no title yet (e.g. extracted IDs with no Jira enrichment)
            ...(itemTitle && !existing.title ? { title: itemTitle } : {}),
          });
        }
      }
    }

    // Step 7: Enrich from task adapter if available
    if (this.taskAdapter) {
      for (const workItemId of allWorkItemIds) {
        // Enrichment is best-effort and the event is already stored: after stop() just skip the rest
        if (stopped()) break;
        try {
          const detail = await this.taskAdapter.getWorkItem(workItemId);
          if (stopped()) break;
          if (detail) {
            this.graph.upsertEnrichment({
              workItemId,
              source: this.taskAdapter.name,
              data: detail as unknown as Record<string, unknown>,
            });
            // Update work item with external data
            this.graph.upsertWorkItem({
              id: workItemId,
              source: this.taskAdapter.name,
              title: detail.title,
              externalStatus: detail.status,
              assignee: detail.assignee,
              url: detail.url,
            });
          }
        } catch (err) {
          log.warn("Task adapter enrichment failed for", workItemId, err);
        }
      }
    }

    return classification;
  }
}
