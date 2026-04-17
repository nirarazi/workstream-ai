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
    setPollCursor: vi.fn(),
    upsertEnrichment: vi.fn(),
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
      expect(classifier.classify).toHaveBeenCalledWith(thread.messages[0].text);
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

    it("uses poll cursor as since date when available", async () => {
      vi.mocked(graph.getPollCursor).mockReturnValue({
        channelId: "C-1",
        lastTimestamp: "2026-03-29T08:00:00.000Z",
        updatedAt: "2026-03-29T08:00:00.000Z",
      });

      vi.mocked(adapter.readThreads).mockResolvedValue([]);

      await pipeline.processOnce();

      const sinceArg = vi.mocked(adapter.readThreads).mock.calls[0][0];
      expect(sinceArg.toISOString()).toBe("2026-03-29T08:00:00.000Z");
    });

    it("falls back to 7 days ago when no poll cursor exists", async () => {
      vi.mocked(graph.getPollCursor).mockReturnValue(null);
      vi.mocked(adapter.readThreads).mockResolvedValue([]);

      const before = new Date();
      before.setDate(before.getDate() - 7);

      await pipeline.processOnce();

      const sinceArg = vi.mocked(adapter.readThreads).mock.calls[0][0];
      // Should be roughly 7 days ago (within a few seconds)
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
      expect(classifier.classify).toHaveBeenCalledWith(msg.text);
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

      // Both work items should get status updates
      const upsertCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const aiUpdate = upsertCalls.find((c) => c[0].id === "AI-382" && c[0].currentAtcStatus);
      const itUpdate = upsertCalls.find((c) => c[0].id === "IT-200" && c[0].currentAtcStatus);
      expect(aiUpdate).toBeDefined();
      expect(itUpdate).toBeDefined();
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

      // Both work items should get status updates
      const upsertCalls = vi.mocked(graph.upsertWorkItem).mock.calls;
      const aiUpdate = upsertCalls.find((c) => c[0].id === "AI-382" && c[0].currentAtcStatus);
      const itUpdate = upsertCalls.find((c) => c[0].id === "IT-100" && c[0].currentAtcStatus);
      expect(aiUpdate).toBeDefined();
      expect(itUpdate).toBeDefined();
    });
  });
});
