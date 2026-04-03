// core/pipeline.ts — Central orchestration loop: read → classify → link → store → enrich

import { createLogger } from "./logger.js";
import type { Config } from "./config.js";
import type { Classification, Message, Thread } from "./types.js";
import type { PlatformAdapter } from "./adapters/platforms/interface.js";
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
  private platformAdapter: PlatformAdapter;
  private classifier: Classifier;
  private graph: ContextGraph;
  private linker: WorkItemLinker;
  private taskAdapter?: TaskAdapter;
  private config?: Config;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    platformAdapter: PlatformAdapter,
    classifier: Classifier,
    graph: ContextGraph,
    linker: WorkItemLinker,
    taskAdapter?: TaskAdapter,
    config?: Config,
  ) {
    this.platformAdapter = platformAdapter;
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
    const intervalSeconds = this.config?.slack?.pollInterval ?? DEFAULT_POLL_INTERVAL;
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
    const channels = this.config?.slack?.channels ?? [];
    let processed = 0;
    let classified = 0;
    let errors = 0;

    // Determine the since date per channel, using poll cursors or fallback
    const since = this.getSinceDate(channels);

    let threads: Thread[];
    try {
      threads = await this.platformAdapter.readThreads(since, channels.length > 0 ? channels : undefined);
    } catch (err) {
      log.error("Failed to read threads from platform adapter", err);
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
        confidence: existing.confidence,
        reason: existing.reason,
        workItemIds: existing.workItemId ? [existing.workItemId] : [],
      };
    }

    // Step 1: Link work items from message text
    const workItemIds = this.linker.linkMessage(message.text, thread.id);

    // Step 2: Classify the message
    const classification = await this.classifier.classify(message.text);

    // Merge work item IDs from linker and classifier
    const allWorkItemIds = new Set([...workItemIds, ...classification.workItemIds]);

    // Step 3: Upsert agent
    const agent = this.graph.upsertAgent({
      id: message.userId,
      name: message.userName,
      platform: message.platform,
      platformUserId: message.userId,
      avatarUrl: message.userAvatarUrl ?? null,
    });

    // Step 4: Upsert thread in graph
    this.graph.upsertThread({
      id: thread.id,
      channelId: thread.channelId,
      channelName: thread.channelName,
      platformMeta: thread.platformMeta,
      platform: thread.platform,
      workItemId: workItemIds.length > 0 ? workItemIds[0] : undefined,
      lastActivity: message.timestamp,
      messageCount: thread.messages.length,
    });

    // Step 5: Insert event with classification
    const primaryWorkItemId = allWorkItemIds.size > 0 ? [...allWorkItemIds][0] : null;

    this.graph.insertEvent({
      threadId: thread.id,
      messageId: message.id,
      workItemId: primaryWorkItemId,
      agentId: agent.id,
      status: classification.status,
      confidence: classification.confidence,
      reason: classification.reason,
      rawText: message.text,
      timestamp: message.timestamp,
    });

    // Step 6: Update work item status if confidence is higher than existing
    for (const workItemId of allWorkItemIds) {
      const existing = this.graph.getWorkItemById(workItemId);
      if (existing) {
        const shouldUpdate =
          !existing.currentConfidence ||
          classification.confidence > existing.currentConfidence;

        if (shouldUpdate) {
          this.graph.upsertWorkItem({
            id: workItemId,
            source: existing.source,
            currentAtcStatus: classification.status,
            currentConfidence: classification.confidence,
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
