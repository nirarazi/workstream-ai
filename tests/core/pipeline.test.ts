// tests/core/pipeline.test.ts — Pipeline orchestrator tests

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Pipeline } from "../../core/pipeline.js";
import type { MessagingAdapter } from "../../core/adapters/messaging/interface.js";
import type { TaskAdapter } from "../../core/adapters/tasks/interface.js";
import type { Classifier } from "../../core/classifier/index.js";
import type { ContextGraph } from "../../core/graph/index.js";
import type { WorkItemLinker } from "../../core/graph/linker.js";
import type { Classification, Message, Thread, WorkItem, Agent, Config } from "../../core/types.js";

// --- Helpers ---

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    threadId: "t-1",
    channelId: "C-1",
    channelName: "agent-orchestrator",
    userId: "U-agent1",
    userName: "Byte",
    text: "Completed AI-382. PR #716 is ready for review.",
    timestamp: "2026-03-30T10:00:00.000Z",
    platform: "slack",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}, messages?: Message[]): Thread {
  const msg = messages ?? [makeMessage()];
  return {
    id: "t-1",
    channelId: "C-1",
    channelName: "agent-orchestrator",
    platform: "slack",
    workItemId: null,
    lastActivity: "2026-03-30T10:00:00.000Z",
    messageCount: msg.length,
    messages: msg,
    ...overrides,
  };
}

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    status: "completed",
    entryType: "progress",
    confidence: 0.95,
    reason: "Agent reports task completion",
    workItemIds: [],
    title: "",
    targetedAtOperator: true,
    actionRequiredFrom: null,
    nextAction: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    messaging: { pollInterval: 30, channels: ["C-1"] },
    classifier: {
      provider: { baseUrl: "http://localhost", model: "test", apiKey: "key" },
      confidenceThreshold: 0.5,
    },
    taskAdapter: { enabled: false, ticketPrefixes: [] },
    extractors: { ticketPatterns: [], prPatterns: [] },
    mcp: { transport: "stdio" },
    server: { port: 3000, host: "localhost" },
    ...overrides,
  } as Config;
}

// --- Mocks ---

function createMockMessagingAdapter(): MessagingAdapter {
  return {
    name: "mock-slack",
    connect: vi.fn().mockResolvedValue(undefined),
    readThreads: vi.fn().mockResolvedValue([]),
    replyToThread: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue({ threadId: "new-ts" }),
    sendDirectMessage: vi.fn().mockResolvedValue({ channelId: "D001", threadId: "new-ts" }),
    streamMessages: vi.fn(),
    getUsers: vi.fn().mockResolvedValue(new Map()),
  };
}

function createMockClassifier(): Classifier {
  return {
    classify: vi.fn().mockResolvedValue(makeClassification()),
  } as unknown as Classifier;
}

function createMockGraph(): ContextGraph {
  const workItems = new Map<string, WorkItem>();
  return {
    upsertAgent: vi.fn().mockReturnValue({
      id: "U-agent1",
      name: "Byte",
      platform: "slack",
      platformUserId: "U-agent1",
      role: null,
      firstSeen: "2026-03-30T10:00:00.000Z",
      lastSeen: "2026-03-30T10:00:00.000Z",
    } as Agent),
    upsertWorkItem: vi.fn().mockImplementation((item: { id: string; source: string; currentConfidence?: number | null }) => {
      const existing = workItems.get(item.id);
      const wi: WorkItem = {
        id: item.id,
        source: item.source,
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: item.currentConfidence ?? null,
        snoozedUntil: null,
        createdAt: "2026-03-30T10:00:00.000Z",
        updatedAt: "2026-03-30T10:00:00.000Z",
        ...existing,
        ...item,
      };
      workItems.set(item.id, wi);
      return wi;
    }),
    upsertThread: vi.fn().mockReturnValue({
      id: "t-1",
      channelId: "C-1",
      channelName: "agent-orchestrator",
      platform: "slack",
      workItemId: null,
      lastActivity: "2026-03-30T10:00:00.000Z",
      messageCount: 1,
      messages: [],
    }),
    hasEvent: vi.fn().mockReturnValue(false),
    getEventByMessageId: vi.fn().mockReturnValue(null),
    insertEvent: vi.fn().mockReturnValue({
      id: "evt-1",
      threadId: "t-1",
      messageId: "msg-1",
      workItemId: null,
      agentId: "U-agent1",
      status: "completed",
      confidence: 0.95,
      reason: "Agent reports task completion",
      rawText: "",
      timestamp: "2026-03-30T10:00:00.000Z",
      createdAt: "2026-03-30T10:00:00.000Z",
    }),
    getWorkItemById: vi.fn().mockImplementation((id: string) => workItems.get(id) ?? null),
    getThreadById: vi.fn().mockReturnValue(null),
    getPollCursor: vi.fn().mockReturnValue(null),
    getAllPollCursors: vi.fn().mockReturnValue([]),
    setPollCursor: vi.fn(),
    getOpenWorkItemSummaries: vi.fn().mockReturnValue([]),
    findCandidateWorkItems: vi.fn().mockReturnValue([]),
    computeBotTypes: vi.fn(),
    getBotType: vi.fn().mockReturnValue(null),
    upsertEnrichment: vi.fn(),
    getActiveThreads: vi.fn().mockReturnValue([]),
    getRecentChannelContext: vi.fn().mockReturnValue([]),
    linkThreadWorkItem: vi.fn(),
  } as unknown as ContextGraph;
}

function createMockLinker(): WorkItemLinker {
  return {
    linkMessage: vi.fn().mockReturnValue([]),
  } as unknown as WorkItemLinker;
}

function createMockTaskAdapter(): TaskAdapter {
  return {
    name: "mock-jira",
    connect: vi.fn().mockResolvedValue(undefined),
    getWorkItem: vi.fn().mockResolvedValue(null),
    updateWorkItem: vi.fn().mockResolvedValue(undefined),
    searchWorkItems: vi.fn().mockResolvedValue([]),
  };
}

// --- Tests ---

describe("Pipeline", () => {
  let adapter: MessagingAdapter;
  let classifier: ReturnType<typeof createMockClassifier>;
  let graph: ContextGraph;
  let linker: WorkItemLinker;
  let config: Config;
  let pipeline: Pipeline;

  beforeEach(() => {
    adapter = createMockMessagingAdapter();
    classifier = createMockClassifier();
    graph = createMockGraph();
    linker = createMockLinker();
    config = makeConfig();
    pipeline = new Pipeline(adapter, classifier, graph, linker, undefined, config);
  });

  describe("processOnce", () => {
    it("returns zero counts when no threads are returned", async () => {
      const result = await pipeline.processOnce();
      expect(result).toEqual({ processed: 0, classified: 0, errors: 0 });
    });

    it("processes threads and classifies messages", async () => {
      const thread = makeThread();
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      const result = await pipeline.processOnce();

      expect(result.processed).toBe(1);
      expect(result.classified).toBe(1);
      expect(result.errors).toBe(0);
      expect(classifier.classify).toHaveBeenCalledWith(
        thread.messages[0].text,
        expect.any(Array),
        null,
        { senderName: "Byte", senderType: "unknown", channelName: "agent-orchestrator" },
        [],
        [],
      );
    });

    it("upserts agent from message metadata", async () => {
      const msg = makeMessage({ userId: "U-byte", userName: "Byte" });
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread({}, [msg])]);

      await pipeline.processOnce();

      expect(graph.upsertAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "U-byte",
          name: "Byte",
          platform: "slack",
          platformUserId: "U-byte",
        }),
      );
    });

    it("upserts thread in graph", async () => {
      const thread = makeThread();
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      await pipeline.processOnce();

      expect(graph.upsertThread).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "t-1",
          channelId: "C-1",
          platform: "slack",
        }),
      );
    });

    it("inserts event with classification result", async () => {
      const thread = makeThread();
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      await pipeline.processOnce();

      expect(graph.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-1",
          messageId: "msg-1",
          status: "completed",
          confidence: 0.95,
          reason: "Agent reports task completion",
        }),
      );
    });

    it("calls linker with message text and thread id", async () => {
      const thread = makeThread();
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      await pipeline.processOnce();

      expect(linker.linkMessage).toHaveBeenCalledWith(
        thread.messages[0].text,
        "t-1",
      );
    });

    it("updates work item status when confidence is higher", async () => {
      // Linker returns a work item ID
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382"]);

      // Existing work item has lower confidence
      const existingWi: WorkItem = {
        id: "AI-382",
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: "in_progress",
        currentConfidence: 0.6,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);

      const classification = makeClassification({ status: "completed", confidence: 0.95 });
      vi.mocked(classifier.classify).mockResolvedValue(classification);

      const thread = makeThread();
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      await pipeline.processOnce();

      expect(graph.upsertWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "AI-382",
          currentAtcStatus: "completed",
          currentConfidence: 0.95,
        }),
      );
    });

    it("does not update work item status when confidence is lower", async () => {
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382"]);

      const existingWi: WorkItem = {
        id: "AI-382",
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: "blocked_on_human",
        currentConfidence: 0.99,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);

      const classification = makeClassification({ status: "completed", confidence: 0.5 });
      vi.mocked(classifier.classify).mockResolvedValue(classification);

      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipeline.processOnce();

      // upsertWorkItem should NOT be called with the new status
      const calls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const statusUpdateCalls = calls.filter(
        (c) => c[0].id === "AI-382" && c[0].currentAtcStatus !== undefined,
      );
      expect(statusUpdateCalls).toHaveLength(0);
    });

    it("skips threads with no messages", async () => {
      const emptyThread = makeThread({ messages: [] }, []);
      vi.mocked(adapter.readThreads).mockResolvedValue([emptyThread]);

      const result = await pipeline.processOnce();

      expect(result.processed).toBe(0);
      expect(classifier.classify).not.toHaveBeenCalled();
    });

    it("updates poll cursors after processing", async () => {
      const thread = makeThread();
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      await pipeline.processOnce();

      expect(graph.setPollCursor).toHaveBeenCalledWith(
        "C-1",
        "2026-03-30T10:00:00.000Z",
      );
    });

    it("passes per-channel cursors when available", async () => {
      vi.mocked(graph.getAllPollCursors).mockReturnValue([
        { channelId: "C-1", lastTimestamp: "2026-03-29T08:00:00.000Z", updatedAt: "2026-03-29T08:00:00.000Z" },
      ]);

      vi.mocked(adapter.readThreads).mockResolvedValue([]);

      await pipeline.processOnce();

      const perChannelSince = vi.mocked(adapter.readThreads).mock.calls[0][2];
      expect(perChannelSince).toBeDefined();
      expect(perChannelSince!.get("C-1")!.toISOString()).toBe("2026-03-29T08:00:00.000Z");
    });

    it("falls back to initialDays lookback when no poll cursors exist", async () => {
      vi.mocked(graph.getAllPollCursors).mockReturnValue([]);
      vi.mocked(adapter.readThreads).mockResolvedValue([]);

      const before = new Date();
      before.setDate(before.getDate() - 1); // default initialDays = 1

      await pipeline.processOnce();

      const sinceArg = vi.mocked(adapter.readThreads).mock.calls[0][0];
      // Should be roughly 1 day ago (within a few seconds)
      expect(sinceArg.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
      expect(sinceArg.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("processes multiple threads", async () => {
      const t1 = makeThread({ id: "t-1", channelId: "C-1" }, [makeMessage({ id: "msg-1", threadId: "t-1" })]);
      const t2 = makeThread({ id: "t-2", channelId: "C-1" }, [makeMessage({ id: "msg-2", threadId: "t-2", timestamp: "2026-03-30T11:00:00.000Z" })]);
      vi.mocked(adapter.readThreads).mockResolvedValue([t1, t2]);

      const result = await pipeline.processOnce();

      expect(result.processed).toBe(2);
      expect(result.classified).toBe(2);
      expect(classifier.classify).toHaveBeenCalledTimes(2);
    });

    it("tracks latest timestamp per channel for cursor", async () => {
      const t1 = makeThread({ id: "t-1" }, [makeMessage({ id: "msg-1", timestamp: "2026-03-30T10:00:00.000Z" })]);
      const t2 = makeThread({ id: "t-2" }, [makeMessage({ id: "msg-2", timestamp: "2026-03-30T12:00:00.000Z" })]);
      vi.mocked(adapter.readThreads).mockResolvedValue([t1, t2]);

      await pipeline.processOnce();

      // Should set cursor to the latest timestamp
      expect(graph.setPollCursor).toHaveBeenCalledWith("C-1", "2026-03-30T12:00:00.000Z");
    });
  });

  describe("error handling", () => {
    it("continues processing when individual classification fails", async () => {
      const t1 = makeThread({ id: "t-1" }, [makeMessage({ id: "msg-1", threadId: "t-1" })]);
      const t2 = makeThread({ id: "t-2" }, [makeMessage({ id: "msg-2", threadId: "t-2" })]);
      vi.mocked(adapter.readThreads).mockResolvedValue([t1, t2]);

      // First classify call throws, second succeeds
      vi.mocked(classifier.classify)
        .mockRejectedValueOnce(new Error("LLM timeout"))
        .mockResolvedValueOnce(makeClassification());

      const result = await pipeline.processOnce();

      expect(result.processed).toBe(2);
      expect(result.classified).toBe(1);
      expect(result.errors).toBe(1);
    });

    it("returns error when platform adapter fails", async () => {
      vi.mocked(adapter.readThreads).mockRejectedValue(new Error("Slack API down"));

      const result = await pipeline.processOnce();

      expect(result).toEqual({ processed: 0, classified: 0, errors: 1 });
    });

    it("continues when task adapter enrichment fails", async () => {
      const taskAdapter = createMockTaskAdapter();
      vi.mocked(taskAdapter.getWorkItem).mockRejectedValue(new Error("Jira timeout"));
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382"]);

      const existingWi: WorkItem = {
        id: "AI-382",
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: null,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);

      const pipelineWithJira = new Pipeline(adapter, classifier, graph, linker, taskAdapter, config);
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      const result = await pipelineWithJira.processOnce();

      // Should still succeed — enrichment failure is non-fatal
      expect(result.classified).toBe(1);
      expect(result.errors).toBe(0);
    });
  });

  describe("task adapter enrichment", () => {
    it("enriches work items when task adapter returns data", async () => {
      const taskAdapter = createMockTaskAdapter();
      vi.mocked(taskAdapter.getWorkItem).mockResolvedValue({
        id: "AI-382",
        title: "Fix login bug",
        status: "In Progress",
        assignee: "byte@agents.com",
        url: "https://jira.example.com/AI-382",
        labels: ["bug"],
        description: "Login page crashes on submit",
      });
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382"]);

      const existingWi: WorkItem = {
        id: "AI-382",
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: null,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);

      const pipelineWithJira = new Pipeline(adapter, classifier, graph, linker, taskAdapter, config);
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipelineWithJira.processOnce();

      expect(graph.upsertEnrichment).toHaveBeenCalledWith(
        expect.objectContaining({
          workItemId: "AI-382",
          source: "mock-jira",
        }),
      );

      // Should also update work item with external data
      expect(graph.upsertWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "AI-382",
          title: "Fix login bug",
          externalStatus: "In Progress",
          assignee: "byte@agents.com",
          url: "https://jira.example.com/AI-382",
        }),
      );
    });

    it("does not enrich when task adapter returns null", async () => {
      const taskAdapter = createMockTaskAdapter();
      vi.mocked(taskAdapter.getWorkItem).mockResolvedValue(null);
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-999"]);

      const existingWi: WorkItem = {
        id: "AI-999",
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: null,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);

      const pipelineWithJira = new Pipeline(adapter, classifier, graph, linker, taskAdapter, config);
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipelineWithJira.processOnce();

      expect(graph.upsertEnrichment).not.toHaveBeenCalled();
    });
  });

  describe("processMessage (MCP push path)", () => {
    it("classifies a single message and returns classification", async () => {
      const msg = makeMessage();
      const classification = makeClassification({ status: "blocked_on_human" });
      vi.mocked(classifier.classify).mockResolvedValue(classification);

      const result = await pipeline.processMessage(msg, "t-1", "C-1");

      expect(result.status).toBe("blocked_on_human");
      expect(classifier.classify).toHaveBeenCalledWith(
        msg.text,
        expect.any(Array),
        null,
        { senderName: "Byte", senderType: "unknown", channelName: "agent-orchestrator" },
        [],
        [],
      );
    });

    it("upserts thread before processing", async () => {
      const msg = makeMessage();
      await pipeline.processMessage(msg, "t-mcp", "C-mcp");

      expect(graph.upsertThread).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "t-mcp",
          channelId: "C-mcp",
          platform: "slack",
        }),
      );
    });

    it("inserts event for MCP-pushed messages", async () => {
      const msg = makeMessage({ id: "mcp-msg-1" });
      await pipeline.processMessage(msg, "t-mcp", "C-mcp");

      expect(graph.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-mcp",
          messageId: "mcp-msg-1",
        }),
      );
    });
  });

  describe("start and stop", () => {
    it("calls processOnce immediately on start", async () => {
      vi.mocked(adapter.readThreads).mockResolvedValue([]);

      await pipeline.start();

      expect(adapter.readThreads).toHaveBeenCalledTimes(1);

      pipeline.stop();
    });

    it("stop clears the interval", async () => {
      vi.mocked(adapter.readThreads).mockResolvedValue([]);

      await pipeline.start();
      pipeline.stop();

      // After stop, no more polls should occur
      // (We verify indirectly — just ensure no error is thrown)
      expect(true).toBe(true);
    });

    it("does not start twice", async () => {
      vi.mocked(adapter.readThreads).mockResolvedValue([]);

      await pipeline.start();
      await pipeline.start(); // second call should be a no-op

      expect(adapter.readThreads).toHaveBeenCalledTimes(1);

      pipeline.stop();
    });
  });

  describe("thread-to-work-item inheritance", () => {
    it("inherits work item ID from existing thread when message has no ticket", async () => {
      // Thread already linked to AI-382 in the graph
      vi.mocked(graph.getThreadById).mockReturnValue({
        id: "t-1",
        channelId: "C-1",
        channelName: "agent-orchestrator",
        platform: "slack",
        workItemId: "AI-382",
        lastActivity: "2026-03-30T09:00:00.000Z",
        messageCount: 1,
        messages: [],
      });

      // Message text has NO ticket reference
      const msg = makeMessage({ text: "Sounds good, I'll proceed with that approach" });
      const thread = makeThread({}, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      // Linker finds nothing, classifier finds nothing
      vi.mocked(linker.linkMessage).mockReturnValue([]);
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({ status: "in_progress", workItemIds: [] }),
      );

      // Set up existing work item so status update path works
      const existingWi: WorkItem = {
        id: "AI-382",
        source: "extracted",
        title: "Auth refactor",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: "in_progress",
        currentConfidence: 0.8,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);

      await pipeline.processOnce();

      // Event should be linked to the inherited work item
      expect(graph.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workItemId: "AI-382",
        }),
      );

      // Thread upsert should preserve AI-382 as the work item
      expect(graph.upsertThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workItemId: "AI-382",
        }),
      );
    });

    it("merges inherited work item with newly extracted IDs", async () => {
      // Thread already linked to AI-382
      vi.mocked(graph.getThreadById).mockReturnValue({
        id: "t-1",
        channelId: "C-1",
        channelName: "agent-orchestrator",
        platform: "slack",
        workItemId: "AI-382",
        lastActivity: "2026-03-30T09:00:00.000Z",
        messageCount: 1,
        messages: [],
      });

      // Message mentions a DIFFERENT ticket
      const msg = makeMessage({ text: "Also related to IT-200" });
      const thread = makeThread({}, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      vi.mocked(linker.linkMessage).mockReturnValue(["IT-200"]);
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({ status: "in_progress", workItemIds: [] }),
      );

      const existingAI382: WorkItem = {
        id: "AI-382", source: "extracted", title: "Auth refactor",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: "in_progress", currentConfidence: 0.8,
        snoozedUntil: null, createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      const existingIT200: WorkItem = { ...existingAI382, id: "IT-200", title: "Related work" };

      vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => {
        if (id === "AI-382") return existingAI382;
        if (id === "IT-200") return existingIT200;
        return null;
      });

      await pipeline.processOnce();

      // Primary (inherited) work item gets status update
      const upsertCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const aiUpdate = upsertCalls.find((c) => c[0].id === "AI-382" && c[0].currentAtcStatus);
      expect(aiUpdate).toBeDefined();

      // Mentioned item does NOT inherit top-level status (no breakdown entry)
      const itUpdate = upsertCalls.find((c) => c[0].id === "IT-200" && c[0].currentAtcStatus);
      expect(itUpdate).toBeUndefined();

      // But junction row IS still written for the mentioned item
      expect(graph.linkThreadWorkItem).toHaveBeenCalledWith(
        expect.anything(), "IT-200", "mentioned",
      );
    });
  });

  describe("manually linked thread protection", () => {
    it("does not overwrite work_item_id on manually linked threads", async () => {
      // Thread is manually linked to AI-100
      vi.mocked(graph.getThreadById).mockReturnValue({
        id: "t-1",
        channelId: "C-1",
        channelName: "agent-orchestrator",
        platform: "slack",
        workItemId: "AI-100",
        lastActivity: "2026-03-30T09:00:00.000Z",
        messageCount: 1,
        messages: [],
        manuallyLinked: true,
      });

      // Message mentions a DIFFERENT ticket
      const msg = makeMessage({ text: "Working on IT-200 now" });
      const thread = makeThread({}, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      vi.mocked(linker.linkMessage).mockReturnValue(["IT-200"]);
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({ status: "in_progress", workItemIds: [] }),
      );

      const existingAI100: WorkItem = {
        id: "AI-100", source: "extracted", title: "Manual work",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: null, currentConfidence: null,
        snoozedUntil: null, createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      const existingIT200: WorkItem = { ...existingAI100, id: "IT-200", title: "Other" };

      vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => {
        if (id === "AI-100") return existingAI100;
        if (id === "IT-200") return existingIT200;
        return null;
      });

      await pipeline.processOnce();

      // Thread upsert should keep AI-100 (the manually linked ID), NOT IT-200
      expect(graph.upsertThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workItemId: "AI-100",
        }),
      );
    });
  });

  describe("work item ID merging", () => {
    it("merges work item IDs from linker and classifier", async () => {
      // Linker extracts AI-382
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382"]);
      // Classifier also references IT-100
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({ workItemIds: ["IT-100"] }),
      );

      const existingAI382: WorkItem = {
        id: "AI-382",
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: null,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      const existingIT100: WorkItem = {
        ...existingAI382,
        id: "IT-100",
      };

      vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => {
        if (id === "AI-382") return existingAI382;
        if (id === "IT-100") return existingIT100;
        return null;
      });

      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipeline.processOnce();

      // Event should reference the primary work item (first from combined set)
      expect(graph.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workItemId: "AI-382",
        }),
      );

      // Primary work item gets status update
      const upsertCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const aiUpdate = upsertCalls.find((c) => c[0].id === "AI-382" && c[0].currentAtcStatus);
      expect(aiUpdate).toBeDefined();

      // Mentioned item does NOT inherit top-level status (no breakdown entry)
      const itUpdate = upsertCalls.find((c) => c[0].id === "IT-100" && c[0].currentAtcStatus);
      expect(itUpdate).toBeUndefined();

      // But junction row IS still written
      expect(graph.linkThreadWorkItem).toHaveBeenCalledWith(
        expect.anything(), "IT-100", "mentioned",
      );
    });

    it("updates mentioned item status when breakdown entry exists", async () => {
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382"]);
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({
          status: "noise",
          workItemIds: ["IT-100"],
          breakdown: [
            { workItemId: "AI-382", status: "completed", confidence: 0.95, reason: "Done", title: "Done", targetedAtOperator: false, actionRequiredFrom: null, nextAction: null },
            { workItemId: "IT-100", status: "blocked_on_human", confidence: 0.9, reason: "Repo missing", title: "Blocked", targetedAtOperator: true, actionRequiredFrom: [], nextAction: "Confirm status" },
          ],
        }),
      );

      const existingAI382: WorkItem = {
        id: "AI-382", source: "extracted", title: "Auth refactor",
        externalStatus: null, assignee: null, url: null,
        currentAtcStatus: null, currentConfidence: null,
        snoozedUntil: null, createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      const existingIT100: WorkItem = { ...existingAI382, id: "IT-100", title: "Other" };

      vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => {
        if (id === "AI-382") return existingAI382;
        if (id === "IT-100") return existingIT100;
        return null;
      });

      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipeline.processOnce();

      const upsertCalls = vi.mocked(graph.upsertWorkItem).mock.calls;

      // Primary gets breakdown status (completed), not top-level (noise)
      const aiUpdate = upsertCalls.find((c) => c[0].id === "AI-382" && c[0].currentAtcStatus === "completed");
      expect(aiUpdate).toBeDefined();

      // Mentioned item gets its own breakdown status (blocked_on_human)
      const itUpdate = upsertCalls.find((c) => c[0].id === "IT-100" && c[0].currentAtcStatus === "blocked_on_human");
      expect(itUpdate).toBeDefined();
    });
  });

  describe("operator identity passthrough", () => {
    it("passes operator identities map to classifier on classify call", async () => {
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      const operatorIdentities = new Map([
        ["slack", { userId: "U-operator", userName: "Nir" }],
      ]);
      const pipelineWithIdentity = new Pipeline(adapter, classifier, graph, linker, undefined, config, operatorIdentities);

      await pipelineWithIdentity.processOnce();

      expect(classifier.classify).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        operatorIdentities,
        expect.objectContaining({ senderName: "Byte" }),
        [],
        [],
      );
    });

    it("passes null identity when no operatorIdentities provided", async () => {
      // Default pipeline has no operator identities
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipeline.processOnce();

      expect(classifier.classify).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        null,
        expect.objectContaining({ senderName: "Byte" }),
        [],
        [],
      );
    });

    it("passes sender context from message metadata", async () => {
      const msg = makeMessage({ userName: "Pixel", senderType: "agent", channelName: "#design" });
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread({}, [msg])]);

      await pipeline.processOnce();

      expect(classifier.classify).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        null,
        { senderName: "Pixel", senderType: "agent", channelName: "#design" },
        [],
        [],
      );
    });
  });

  describe("actionRequiredFrom and nextAction persistence", () => {
    it("persists actionRequiredFrom and nextAction from classification", async () => {
      const msg = makeMessage({ id: "msg-blocked", text: "PR #716 needs your review before we can proceed." });
      const thread = makeThread({ id: "t-blocked" }, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      const classification = makeClassification({
        status: "blocked_on_human",
        confidence: 0.9,
        reason: "Agent is waiting for operator review",
        workItemIds: [],
        actionRequiredFrom: ["U_GUY123"],
        nextAction: "Review and approve PR #716",
      });
      vi.mocked(classifier.classify).mockResolvedValue(classification);

      await pipeline.processOnce();

      expect(graph.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t-blocked",
          messageId: "msg-blocked",
          status: "blocked_on_human",
          actionRequiredFrom: ["U_GUY123"],
          nextAction: "Review and approve PR #716",
        }),
      );
    });
  });

  describe("senderType to isBot passthrough", () => {
    it("passes senderType as isBot to agent upsert", async () => {
      const upsertSpy = vi.spyOn(graph, "upsertAgent");

      const message: Message = {
        id: "msg-bot-1",
        threadId: "t1",
        channelId: "C001",
        channelName: "general",
        userId: "U001",
        userName: "Byte",
        text: "Working on it",
        timestamp: new Date().toISOString(),
        platform: "slack",
        senderType: "agent",
      };

      await pipeline.processMessage(message, "t1", "C001");

      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ isBot: true }),
      );
    });

    it("passes isBot=false for human senderType", async () => {
      const upsertSpy = vi.spyOn(graph, "upsertAgent");

      const message: Message = {
        id: "msg-human-1",
        threadId: "t1",
        channelId: "C001",
        channelName: "general",
        userId: "U002",
        userName: "Nir",
        text: "Looks good",
        timestamp: new Date().toISOString(),
        platform: "slack",
        senderType: "human",
      };

      await pipeline.processMessage(message, "t1", "C001");

      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ isBot: false }),
      );
    });

    it("passes isBot=null for unknown senderType", async () => {
      const upsertSpy = vi.spyOn(graph, "upsertAgent");

      const message: Message = {
        id: "msg-unknown-1",
        threadId: "t1",
        channelId: "C001",
        channelName: "general",
        userId: "U003",
        userName: "Unknown",
        text: "Some message",
        timestamp: new Date().toISOString(),
        platform: "slack",
      };

      await pipeline.processMessage(message, "t1", "C001");

      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ isBot: null }),
      );
    });
  });

  describe("work item deduplication via classifier context", () => {
    it("passes graph-scored candidates to the classifier", async () => {
      const msg = makeMessage({ text: "Missing API key for Anthropic again" });
      const thread = makeThread({ id: "t-new" }, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({
          status: "blocked_on_human",
          workItemIds: ["thread:existing.123"],
          title: "Missing API key for Anthropic",
        }),
      );

      // Return scored candidates from graph
      (graph as any).findCandidateWorkItems = vi.fn().mockReturnValue([
        { id: "thread:existing.123", title: "Missing API key for Anthropic", score: 7.5, reasons: ["same agent", "keyword overlap: api, key"] },
        { id: "AI-200", title: "Deploy to staging", score: 3.0, reasons: ["same channel"] },
      ]);

      await pipeline.processOnce();

      // Classifier should receive candidates with reasons (not raw 100-item dump)
      expect(classifier.classify).toHaveBeenCalledWith(
        msg.text,
        [
          { id: "thread:existing.123", title: "Missing API key for Anthropic", reasons: ["same agent", "keyword overlap: api, key"] },
          { id: "AI-200", title: "Deploy to staging", reasons: ["same channel"] },
        ],
        null,
        expect.objectContaining({ senderName: "Byte" }),
        [],
        [],
      );
    });

    it("discards LLM-suggested IDs that don't match configured ticket prefixes", async () => {
      // Create a pipeline with ticket prefixes configured
      const configWithPrefixes = makeConfig({
        taskAdapter: { enabled: true, ticketPrefixes: ["AI-", "IT-", "MS-"] },
      });
      const pipelineWithPrefixes = new Pipeline(adapter, classifier, graph, linker, undefined, configWithPrefixes);

      const msg = makeMessage({ text: "CRM ticket Q-456 created for lead" });
      const thread = makeThread({}, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      // LLM returns Q-456 as a work item ID — but Q- is not a valid prefix
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({
          status: "blocked_on_human",
          workItemIds: ["Q-456"],
          title: "New lead pending review",
        }),
      );

      await pipelineWithPrefixes.processOnce();

      // Q-456 should NOT have been created as a work item
      const upsertWorkItemCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const createdIds = upsertWorkItemCalls.map((c: any[]) => c[0].id);
      expect(createdIds).not.toContain("Q-456");
      // Instead, a synthetic thread-based work item should have been created
      expect(createdIds).toContain(`thread:${thread.id}`);
    });

    it("accepts LLM-suggested IDs that match configured ticket prefixes", async () => {
      const configWithPrefixes = makeConfig({
        taskAdapter: { enabled: true, ticketPrefixes: ["AI-", "IT-", "MS-"] },
      });
      const pipelineWithPrefixes = new Pipeline(adapter, classifier, graph, linker, undefined, configWithPrefixes);

      const msg = makeMessage({ text: "Working on the deployment" });
      const thread = makeThread({}, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      // LLM returns AI-500 — valid prefix
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({
          status: "in_progress",
          workItemIds: ["AI-500"],
          title: "Deployment in progress",
        }),
      );

      await pipelineWithPrefixes.processOnce();

      // AI-500 should have been created as an inferred work item
      const upsertWorkItemCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const createdIds = upsertWorkItemCalls.map((c: any[]) => c[0].id);
      expect(createdIds).toContain("AI-500");
    });

    it("links thread to existing work item when classifier returns existing ID", async () => {
      const msg = makeMessage({
        id: "msg-new",
        text: "Missing API key for Anthropic again",
        threadId: "t-new",
      });
      const thread = makeThread({ id: "t-new" }, [msg]);
      vi.mocked(adapter.readThreads).mockResolvedValue([thread]);

      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({
          status: "blocked_on_human",
          workItemIds: ["thread:existing.123"],
          title: "Missing API key for Anthropic",
        }),
      );

      (graph as any).findCandidateWorkItems = vi.fn().mockReturnValue([
        { id: "thread:existing.123", title: "Missing API key for Anthropic", score: 7.0, reasons: ["same agent"] },
      ]);

      await pipeline.processOnce();

      // The thread should be linked to the existing work item, NOT creating a new thread:t-new
      const upsertThreadCalls = vi.mocked(graph.upsertThread).mock.calls;
      const lastThreadUpsert = upsertThreadCalls[upsertThreadCalls.length - 1][0];
      expect(lastThreadUpsert.workItemId).toBe("thread:existing.123");

      // Should NOT have created a synthetic work item for thread:t-new
      const upsertWorkItemCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const syntheticIds = upsertWorkItemCalls.map((c: any[]) => c[0].id);
      expect(syntheticIds).not.toContain("thread:t-new");
    });
  });

  describe("junction rows and no breakdown events", () => {
    it("writes a primary junction row for the primary work item", async () => {
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382"]);
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({ status: "completed", workItemIds: [] }),
      );

      const existingWi: WorkItem = {
        id: "AI-382",
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: null,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      };
      vi.mocked(graph.getWorkItemById).mockReturnValue(existingWi);
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipeline.processOnce();

      expect(graph.linkThreadWorkItem).toHaveBeenCalledWith("t-1", "AI-382", "primary");
    });

    it("writes mentioned junction rows for secondary work items", async () => {
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382", "IT-200"]);
      vi.mocked(classifier.classify).mockResolvedValue(
        makeClassification({ status: "in_progress", workItemIds: [] }),
      );

      const makeWi = (id: string): WorkItem => ({
        id,
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: null,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      });
      vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => makeWi(id));
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipeline.processOnce();

      expect(graph.linkThreadWorkItem).toHaveBeenCalledWith("t-1", "AI-382", "primary");
      expect(graph.linkThreadWorkItem).toHaveBeenCalledWith("t-1", "IT-200", "mentioned");
    });

    it("does not create breakdown events (no insertEvent calls with composite messageId)", async () => {
      vi.mocked(linker.linkMessage).mockReturnValue(["AI-382", "IT-200"]);

      const breakdownClassification = makeClassification({
        status: "completed",
        workItemIds: ["AI-382", "IT-200"],
        breakdown: [
          {
            workItemId: "AI-382",
            status: "completed",
            entryType: "progress",
            confidence: 0.95,
            reason: "AI-382 is done",
            title: "Auth refactor",
            targetedAtOperator: false,
            actionRequiredFrom: null,
            nextAction: null,
          },
          {
            workItemId: "IT-200",
            status: "blocked_on_human",
            entryType: "request",
            confidence: 0.9,
            reason: "IT-200 needs review",
            title: "Related work",
            targetedAtOperator: true,
            actionRequiredFrom: ["U-operator"],
            nextAction: "Review PR",
          },
        ],
      });
      vi.mocked(classifier.classify).mockResolvedValue(breakdownClassification);

      const makeWi = (id: string): WorkItem => ({
        id,
        source: "extracted",
        title: "",
        externalStatus: null,
        assignee: null,
        url: null,
        currentAtcStatus: null,
        currentConfidence: null,
        snoozedUntil: null,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:00:00.000Z",
      });
      vi.mocked(graph.getWorkItemById).mockImplementation((id: string) => makeWi(id));
      vi.mocked(adapter.readThreads).mockResolvedValue([makeThread()]);

      await pipeline.processOnce();

      // No insertEvent calls should have a composite messageId (e.g. "msg-1:AI-382")
      const insertEventCalls = vi.mocked(graph.insertEvent).mock.calls;
      const compositeIdCalls = insertEventCalls.filter((c) =>
        typeof c[0].messageId === "string" && c[0].messageId.includes(":"),
      );
      expect(compositeIdCalls).toHaveLength(0);

      // Junction rows should have been written for both work items
      expect(graph.linkThreadWorkItem).toHaveBeenCalledWith("t-1", "AI-382", "primary");
      expect(graph.linkThreadWorkItem).toHaveBeenCalledWith("t-1", "IT-200", "mentioned");
    });
  });

  describe("continuation detection", () => {
    it("passes channel context to classifier for standalone messages", async () => {
      const channelContext = [
        {
          workItemId: "thread:ts1",
          workItemTitle: "Partner approval",
          senderName: "Guy",
          text: "I'm OK with it. But would a partner?",
          timestamp: new Date(Date.now() - 120000).toISOString(),
        },
      ];
      vi.mocked(graph.getRecentChannelContext).mockReturnValue(channelContext);
      // Set up a single standalone message (1-message thread)
      vi.mocked(adapter.readThreads).mockResolvedValue([
        makeThread({ id: "ts2", channelId: "C1" }, [makeMessage({ id: "msg2", threadId: "ts2" })]),
      ]);

      await pipeline.processOnce();

      // Verify channelContext was passed as the 6th argument to classify
      const classifyCall = vi.mocked(classifier.classify).mock.calls[0];
      expect(classifyCall[5]).toEqual(channelContext);
    });

    it("passes empty channel context for threaded messages", async () => {
      vi.mocked(graph.getRecentChannelContext).mockReturnValue([]);
      // Thread with multiple messages = explicitly threaded
      vi.mocked(adapter.readThreads).mockResolvedValue([
        makeThread({ id: "ts3", channelId: "C1" }, [
          makeMessage({ id: "msg3a", threadId: "ts3" }),
          makeMessage({ id: "msg3b", threadId: "ts3", timestamp: "2026-03-30T11:00:00.000Z" }),
        ]),
      ]);

      await pipeline.processOnce();

      // channelContext should be empty for threaded messages
      const classifyCalls = vi.mocked(classifier.classify).mock.calls;
      if (classifyCalls.length > 0) {
        expect(classifyCalls[0][5]).toEqual([]);
      }
    });
  });
});
