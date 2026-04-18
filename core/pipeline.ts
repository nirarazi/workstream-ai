// core/pipeline.ts — Central orchestration loop: read → classify → link → store → enrich

import { createHash } from "node:crypto";
import { createLogger } from "./logger.js";
import type { Config } from "./config.js";
import type { Classification, Message, OperatorIdentity, Thread } from "./types.js";
import type { MessagingAdapter } from "./adapters/messaging/interface.js";
import type { TaskAdapter } from "./adapters/tasks/interface.js";
import type { Classifier } from "./classifier/index.js";
import type { ContextGraph } from "./graph/index.js";
import type { WorkItemLinker } from "./graph/linker.js";

const log = createLogger("pipeline");

const DEFAULT_POLL_INTERVAL = 30;
const DEFAULT_LOOKBACK_DAYS = 1;
const DEFAULT_MAX_THREADS_PER_POLL = 50;

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
  private operatorIdentity: OperatorIdentity | null = null;

  constructor(
    messagingAdapter: MessagingAdapter,
    classifier: Classifier,
    graph: ContextGraph,
    linker: WorkItemLinker,
    taskAdapter?: TaskAdapter,
    config?: Config,
  ) {
    this.messagingAdapter = messagingAdapter;
    this.classifier = classifier;
    this.graph = graph;
    this.linker = linker;
    this.taskAdapter = taskAdapter;
    this.config = config;
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

    // Resolve operator identity from the messaging adapter (cached after first call)
    if (!this.operatorIdentity && this.messagingAdapter.getAuthenticatedUser) {
      this.operatorIdentity = this.messagingAdapter.getAuthenticatedUser() ?? null;
    }

    // Determine the since date per channel, using poll cursors or fallback
    const since = this.getSinceDate(channels);

    let threads: Thread[];
    try {
      threads = await this.messagingAdapter.readThreads(since, channels.length > 0 ? channels : undefined);
    } catch (err) {
      log.error("Failed to read threads from messaging adapter", err);
      return { processed: 0, classified: 0, errors: 1 };
    }

    // Track latest timestamp per channel for cursor updates
    const latestTimestamps = new Map<string, string>();

    // Cap threads per poll to avoid LLM call bursts
    const maxThreads = this.config?.lookback?.maxThreadsPerPoll ?? DEFAULT_MAX_THREADS_PER_POLL;
    const cappedThreads = maxThreads > 0 ? threads.slice(0, maxThreads) : threads;

    if (threads.length > cappedThreads.length) {
      log.info(`Capped threads from ${threads.length} to ${cappedThreads.length} (maxThreadsPerPoll=${maxThreads})`);
    }

    for (const thread of cappedThreads) {
      if (!thread.messages || thread.messages.length === 0) {
        continue;
      }

      const latestMessage = thread.messages[thread.messages.length - 1];
      processed++;

      try {
        await this.processMessageInternal(latestMessage, thread);
        classified++;
      } catch (err) {
        log.error("Failed to process message", latestMessage.id, err);
        errors++;
      }

      // Track the latest timestamp for poll cursor updates
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

  private getContentHash(text: string, threadId: string): string {
    return createHash("sha256").update(`${threadId}:${text}`).digest("hex");
  }

  private getSinceDate(channels: string[]): Date {
    // Find the earliest poll cursor across all channels, or fall back to 7 days ago
    let earliest: Date | null = null;

    for (const channelId of channels) {
      const cursor = this.graph.getPollCursor(channelId);
      if (cursor) {
        const cursorDate = new Date(cursor.lastTimestamp);
        if (!earliest || cursorDate < earliest) {
          earliest = cursorDate;
        }
      }
    }

    if (earliest) {
      return earliest;
    }

    // Use configured lookback or default
    const lookbackDays = this.config?.lookback?.initialDays ?? DEFAULT_LOOKBACK_DAYS;
    const fallback = new Date();
    fallback.setDate(fallback.getDate() - lookbackDays);
    return fallback;
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
          confidence: 0,
          reason: "Work item already completed — skipping classification",
          workItemIds: [inheritedWorkItemId],
          title: "",
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

    // Step 0e: Get open work items for classifier context (dedup)
    const openWorkItems = this.graph.getOpenWorkItemSummaries();

    // Step 1: Link work items from message text (regex — only known prefixes)
    const extractedIds = this.linker.linkMessage(message.text, thread.id);

    // Step 2: Classify the message
    const classification = await this.classifier.classify(message.text, openWorkItems, this.operatorIdentity);

    // Separate LLM-suggested IDs into verified (match an extracted ID) and unverified
    const extractedSet = new Set(extractedIds);
    // Add extracted IDs to allWorkItemIds
    for (const id of extractedIds) {
      allWorkItemIds.add(id);
    }

    for (const llmId of classification.workItemIds) {
      if (!extractedSet.has(llmId)) {
        // LLM suggested an ID that the regex didn't find — treat as inferred
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

    // Step 6: Update work item status if confidence is higher than existing
    // If the classifier returned a per-item breakdown (summary messages), use
    // each item's specific status instead of applying one status to all.
    const breakdownMap = new Map(
      (classification.breakdown ?? []).map((b) => [b.workItemId, b]),
    );

    for (const workItemId of allWorkItemIds) {
      const existing = this.graph.getWorkItemById(workItemId);
      if (existing) {
        const itemClassification = breakdownMap.get(workItemId);
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

        // Insert a dedicated event for breakdown items with actionable status
        // so they surface in the inbox individually
        if (itemClassification && itemClassification.status !== "noise" && itemClassification.status !== "in_progress") {
          this.graph.insertEvent({
            threadId: thread.id,
            messageId: `${message.id}:${workItemId}`,
            workItemId,
            agentId: agent.id,
            status: itemClassification.status,
            entryType: itemClassification.entryType,
            confidence: itemClassification.confidence,
            reason: itemClassification.reason,
            rawText: message.text,
            timestamp: message.timestamp,
            targetedAtOperator: itemClassification.targetedAtOperator,
            actionRequiredFrom: itemClassification.actionRequiredFrom,
            nextAction: itemClassification.nextAction,
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
