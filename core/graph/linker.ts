// core/graph/linker.ts — Links messages to work items via extracted IDs

import { createLogger } from "../logger.js";
import type { ContextGraph } from "./index.js";
import type { Extractor } from "./extractors/interface.js";

const log = createLogger("graph:linker");

/**
 * A message naming at least this many work items is a digest (a daily summary, a sprint audit). It's kept in each
 * item's timeline, but none of them becomes the thread's own, and the pipeline checks what it says against what the
 * app already believes rather than letting it set their status or put them in Needs me: its summary is the agent's
 * view, and a single "blocked" for the whole message isn't each item's.
 */
export const DIGEST_MIN_ITEMS = 3;

/**
 * Whether a message naming these work items (found in its text) is a digest. The thread's own item doesn't count: a
 * reply in a ticket's thread is about that ticket, even when it names two others ("blocked on OPS-1, same for OPS-2
 * and OPS-3"). Only messages that can be digests count at all (the pipeline excludes humans').
 */
export function namesDigest(ids: Iterable<string>, ownItemId: string | null): boolean {
  let others = 0;
  for (const id of ids) if (id !== ownItemId && !id.startsWith("thread:")) others++;
  return others >= DIGEST_MIN_ITEMS;
}

export class WorkItemLinker {
  private extractors: Extractor[];
  private graph: ContextGraph;

  constructor(graph: ContextGraph, extractors: Extractor[]) {
    this.graph = graph;
    this.extractors = extractors;
  }

  /**
   * Extract work item IDs from message text, ensure each exists in the graph,
   * write junction rows for all extracted IDs (first = primary, rest = mentioned; all mentioned in a digest),
   * and keep threads.work_item_id in sync for backwards compatibility.
   * Returns the list of extracted work item IDs.
   */
  linkMessage(text: string, threadId: string, canBeDigest = true): string[] {
    const workItemIds = this.extractIds(text);
    const ownItemId = this.graph.getThreadById(threadId)?.workItemId ?? null;
    const digest = canBeDigest && namesDigest(workItemIds, ownItemId);

    for (const id of workItemIds) {
      this.graph.upsertWorkItem({ id, source: "extracted" });
      log.debug("Ensured work item exists", id);
    }

    // Write junction rows for all extracted IDs
    for (let i = 0; i < workItemIds.length; i++) {
      // In a digest only the thread's own item (if it names it) stays primary
      const relation = digest ? (workItemIds[i] === ownItemId ? "primary" : "mentioned") : i === 0 ? "primary" : "mentioned";
      this.graph.linkThreadWorkItem(threadId, workItemIds[i], relation);
    }

    // Keep threads.work_item_id in sync (backwards compatibility)
    if (workItemIds.length > 0 && !digest) {
      const thread = this.graph.getThreadById(threadId);
      if (thread && !thread.workItemId) {
        this.graph.upsertThread({
          id: thread.id,
          channelId: thread.channelId,
          channelName: thread.channelName,
          platform: thread.platform,
          workItemId: workItemIds[0],
          lastActivity: thread.lastActivity,
          messageCount: thread.messageCount,
        });
        log.debug("Linked thread to work item", threadId, workItemIds[0]);
      }
    }

    return workItemIds;
  }

  /** The work item IDs the extractors find in a message's text */
  extractIds(text: string): string[] {
    const allIds = new Set<string>();
    for (const extractor of this.extractors) {
      for (const id of extractor.extractWorkItemIds(text)) allIds.add(id);
    }
    return Array.from(allIds);
  }
}
