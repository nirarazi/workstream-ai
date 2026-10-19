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
   * Extract work item IDs from message text and link the thread to them: junction rows (first = primary, rest =
   * mentioned; all mentioned in a digest), and threads.work_item_id kept in sync for backwards compatibility.
   * Only the thread's own ticket is created when it's new: the first ID in a message that isn't a digest, in a thread
   * that has no ticket of its own yet ("first" in extraction order: by extractor, then pattern, then position, not
   * necessarily first in the text). Other IDs are linked only when they're work items already, so an ID mentioned in
   * passing (in a digest, a plan, a reply about another ticket) doesn't become an item nobody works on here.
   * Returns the IDs linked, as the message names them (resolveItemRef gives the items they name now); extractIds has
   * all the message names.
   */
  linkMessage(text: string, threadId: string, canBeDigest = true): string[] {
    const extracted = this.extractIds(text);
    const ownItemId = this.graph.getThreadById(threadId)?.workItemId ?? null;
    // An ID naming an item that's another's now (merged into it) counts as that item
    const digest = canBeDigest && namesDigest(extracted.map((id) => this.graph.resolveItemRef(id)), ownItemId);

    const ticketOfItsOwn = ownItemId !== null && !ownItemId.startsWith("thread:");
    const workItemIds = extracted.filter((id, i) => {
      if (this.graph.getWorkItemByRef(id)) return true;
      if (i > 0 || digest || ticketOfItsOwn) {
        log.debug("Not creating a work item for an ID only mentioned", id);
        return false;
      }
      this.graph.upsertWorkItem({ id, source: "extracted" });
      log.debug("Created work item for the thread's own ticket", id);
      return true;
    });

    // Write junction rows for all extracted IDs, for the items they name now
    const itemIds = workItemIds.map((id) => this.graph.resolveItemRef(id));
    for (let i = 0; i < itemIds.length; i++) {
      // In a digest only the thread's own item (if it names it) stays primary
      const relation = digest ? (itemIds[i] === ownItemId ? "primary" : "mentioned") : i === 0 ? "primary" : "mentioned";
      this.graph.linkThreadWorkItem(threadId, itemIds[i], relation);
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
          workItemId: itemIds[0],
          lastActivity: thread.lastActivity,
          messageCount: thread.messageCount,
        });
        log.debug("Linked thread to work item", threadId, itemIds[0]);
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
