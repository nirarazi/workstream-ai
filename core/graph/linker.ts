// core/graph/linker.ts — Links messages to work items via extracted IDs

import { createLogger } from "../logger.js";
import type { ContextGraph } from "./index.js";
import type { Extractor } from "./extractors/interface.js";

const log = createLogger("graph:linker");

export class WorkItemLinker {
  private extractors: Extractor[];
  private graph: ContextGraph;

  constructor(graph: ContextGraph, extractors: Extractor[]) {
    this.graph = graph;
    this.extractors = extractors;
  }

  /**
   * Extract work item IDs from message text, ensure each exists in the graph,
   * write junction rows for all extracted IDs (first = primary, rest = mentioned),
   * and keep threads.work_item_id in sync for backwards compatibility.
   * Returns the list of extracted work item IDs.
   */
  linkMessage(text: string, threadId: string): string[] {
    const allIds = new Set<string>();

    for (const extractor of this.extractors) {
      const ids = extractor.extractWorkItemIds(text);
      for (const id of ids) {
        allIds.add(id);
      }
    }

    const workItemIds = Array.from(allIds);

    for (const id of workItemIds) {
      this.graph.upsertWorkItem({ id, source: "extracted" });
      log.debug("Ensured work item exists", id);
    }

    // Write junction rows for all extracted IDs
    for (let i = 0; i < workItemIds.length; i++) {
      const relation = i === 0 ? "primary" : "mentioned";
      this.graph.linkThreadWorkItem(threadId, workItemIds[i], relation);
    }

    // Keep threads.work_item_id in sync (backwards compatibility)
    if (workItemIds.length > 0) {
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
}
