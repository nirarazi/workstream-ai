// core/pipeline.ts — Central orchestration loop: read → classify → link → store → enrich

import { createHash } from "node:crypto";
import { createLogger } from "./logger.js";
import type { Config } from "./config.js";
import type { Classification, Message, OperatorIdentityMap, Thread } from "./types.js";
import type { MessagingAdapter } from "./adapters/messaging/interface.js";
import type { TaskAdapter } from "./adapters/tasks/interface.js";
import type { Classifier } from "./classifier/index.js";
import type { ContextGraph } from "./graph/index.js";
import type { WorkItemLinker } from "./graph/linker.js";

const log = createLogger("pipeline");

const DEFAULT_POLL_INTERVAL = 30;
const DEFAULT_LOOKBACK_DAYS = 1;
const DEFAULT_MAX_THREADS_PER_POLL = 50;
const DEFAULT_MAX_ACTIVE_THREAD_REPOLLS = 20;

export interface ProcessResult {
  processed: number;
  classified: number;
  errors: number;
}

export class Pipeline {
  private messagingAdapter: MessagingAdapter;
  private classifier: Classifier;
  private graph: ContextGraph;
  private linker: WorkItemLinker;
  private taskAdapter?: TaskAdapter;
  private config?: Config;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private recentContentHashes = new Map<string, Classification>();
  private readonly MAX_CONTENT_HASHES = 1000;
  private operatorIdentities: OperatorIdentityMap | null = null;
  private validPrefixes: string[] | null = null;

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

  async start(): Promise<void> {
    if (this.running) {
      log.warn("Pipeline already running");
      return;
    }
    this.running = true;

    log.info("Pipeline starting");

    // Run once immediately
    const result = await this.processOnce();
    log.info("Initial poll complete", result);

    // Set up the polling interval
    const intervalSeconds = this.config?.messaging?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    this.intervalHandle = setInterval(async () => {
      try {
        const r = await this.processOnce();
        log.info("Poll complete", r);
      } catch (err) {
        log.error("Poll cycle failed", err);
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
    log.info("Pipeline stopped");
  }

  async processOnce(): Promise<ProcessResult> {
    const channels = this.config?.messaging?.channels ?? [];
    let processed = 0;
    let classified = 0;
    let errors = 0;

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

    // Track latest timestamp per channel for cursor updates
    const latestTimestamps = new Map<string, string>();

    // Cap threads per poll to avoid LLM call bursts
    const maxThreads = this.config?.lookback?.maxThreadsPerPoll ?? DEFAULT_MAX_THREADS_PER_POLL;
    const cappedThreads = (maxThreads > 0 ? threads.slice(0, maxThreads) : [...threads]).sort((a, b) => {
      const aTime = a.messages[0]?.timestamp ?? a.lastActivity;
      const bTime = b.messages[0]?.timestamp ?? b.lastActivity;
      return aTime.localeCompare(bTime);
    });

    if (threads.length > cappedThreads.length) {
      log.info(`Capped threads from ${threads.length} to ${cappedThreads.length} (maxThreadsPerPoll=${maxThreads})`);
    }

    // Track thread IDs covered by this channel history poll
    const polledThreadIds = new Set<string>();

    for (const thread of cappedThreads) {
      if (!thread.messages || thread.messages.length === 0) {
        continue;
      }

      polledThreadIds.add(thread.id);

      // Process ALL unprocessed messages in order (oldest → newest), not just
      // the latest.  The hasEvent() check inside processMessageInternal is a
      // cheap DB lookup and will skip already-processed messages without an
      // LLM call.  Processing every message ensures intermediate work-item
      // references and status transitions are captured.
      for (const message of thread.messages) {
        if (this.graph.hasEvent(message.id, thread.id)) {
          continue; // already classified — skip cheaply
        }
        processed++;
        try {
          await this.processMessageInternal(message, thread);
          classified++;
        } catch (err) {
          log.error("Failed to process message", message.id, err);
          errors++;
        }
      }

      // Track the latest timestamp for poll cursor updates
      const latestMessage = thread.messages[thread.messages.length - 1];
      const channelId = thread.channelId;
      const existing = latestTimestamps.get(channelId);
      if (!existing || latestMessage.timestamp > existing) {
        latestTimestamps.set(channelId, latestMessage.timestamp);
      }
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
    if (maxRepolls > 0) {
      const activeThreads = this.graph.getActiveThreads(maxRepolls);
      let repolled = 0;

      for (const activeThread of activeThreads) {
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
            if (this.graph.hasEvent(msg.id, activeThread.id)) continue;
            hadNew = true;
            processed++;
            try {
              await this.processMessageInternal(msg, threadObj);
              classified++;
            } catch (err) {
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

    // Recompute bot types after processing — more data may refine classifications
    if (processed > 0) {
      this.graph.computeBotTypes();
    }

    return { processed, classified, errors };
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

  private isValidWorkItemId(id: string): boolean {
    const prefixes = this.getValidPrefixes();
    if (prefixes.length === 0) return true; // no prefixes configured → accept all
    // Also allow synthetic IDs (thread:xxx) and known patterns like "PR #123"
    if (id.startsWith("thread:")) return true;
    return prefixes.some(prefix => id.toUpperCase().startsWith(prefix));
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

    const allCursors = this.graph.getAllPollCursors();
    const perChannelSince = new Map<string, Date>();

    for (const cursor of allCursors) {
      perChannelSince.set(cursor.channelId, new Date(cursor.lastTimestamp));
    }

    return { globalSince, perChannelSince };
  }

  private async processMessageInternal(message: Message, thread: Thread): Promise<Classification> {
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
        })
      : [];

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
    const classification = await this.classifier.classify(message.text, candidateContext, this.operatorIdentities, senderContext, this.getValidPrefixes(), channelContext);

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
    this.recentContentHashes.set(hash, classification);
    if (this.recentContentHashes.size > this.MAX_CONTENT_HASHES) {
      const firstKey = this.recentContentHashes.keys().next().value;
      if (firstKey) this.recentContentHashes.delete(firstKey);
    }

    // Step 2b: If no work item IDs found and this isn't noise, create a synthetic work item
    // keyed by thread ID so the conversation stays grouped under one item
    if (allWorkItemIds.size === 0 && classification.status !== "noise") {
      const syntheticId = `thread:${thread.id}`;
      this.graph.upsertWorkItem({
        id: syntheticId,
        source: "inferred",
        title: classification.title || "Untitled conversation",
        currentAtcStatus: classification.status,
        currentConfidence: classification.confidence,
      });
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
      lastActivity: message.timestamp,
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

        const shouldUpdate =
          !existing.currentConfidence ||
          itemConfidence >= existing.currentConfidence;

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
        try {
          const detail = await this.taskAdapter.getWorkItem(workItemId);
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
