// core/actions.ts — Backend logic for operator actions on work items

import type { PlatformAdapter } from "./adapters/messaging/interface.js";
import type { ContextGraph } from "./graph/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("actions");

export type ActionType = "approve" | "redirect" | "close" | "snooze";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export class ActionHandler {
  constructor(
    private graph: ContextGraph,
    private platformAdapter?: PlatformAdapter,
  ) {}

  async execute(
    workItemId: string,
    action: ActionType,
    message?: string,
    snoozeDuration?: number,
  ): Promise<ActionResult> {
    try {
      const workItem = this.graph.getWorkItemById(workItemId);
      if (!workItem) {
        return { ok: false, error: "Work item not found" };
      }

      switch (action) {
        case "approve":
          return await this.handleApprove(workItemId, message);
        case "redirect":
          return await this.handleRedirect(workItemId, message);
        case "close":
          return await this.handleClose(workItemId, message);
        case "snooze":
          return this.handleSnooze(workItemId, snoozeDuration);
        default:
          return { ok: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("Action failed", action, workItemId, errorMessage);
      return { ok: false, error: errorMessage };
    }
  }

  private async sendThreadMessage(workItemId: string, text: string): Promise<void> {
    if (!this.platformAdapter) return;

    const threads = this.graph.getThreadsForWorkItem(workItemId);
    if (threads.length === 0) return;

    const latestThread = threads[0]; // Already sorted by last_activity DESC
    try {
      await this.platformAdapter.replyToThread(latestThread.id, latestThread.channelId, text);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("Failed to send thread message", errorMessage);
      // Don't rethrow — graph update is the important part
    }
  }

  private async handleApprove(workItemId: string, message?: string): Promise<ActionResult> {
    await this.sendThreadMessage(workItemId, `✅ Approved. ${message || ""}`.trim());

    this.graph.upsertWorkItem({
      id: workItemId,
      source: "",
      currentAtcStatus: "completed",
      snoozedUntil: null,
    });

    log.info("Approved work item", workItemId);
    return { ok: true };
  }

  private async handleRedirect(workItemId: string, message?: string): Promise<ActionResult> {
    await this.sendThreadMessage(workItemId, `↩️ Redirecting. ${message || ""}`.trim());

    // Keep work item status as-is — operator handles redirection manually
    log.info("Redirected work item", workItemId);
    return { ok: true };
  }

  private async handleClose(workItemId: string, message?: string): Promise<ActionResult> {
    await this.sendThreadMessage(workItemId, `🔒 Closed. ${message || ""}`.trim());

    this.graph.upsertWorkItem({
      id: workItemId,
      source: "",
      currentAtcStatus: "completed",
      snoozedUntil: null,
    });

    log.info("Closed work item", workItemId);
    return { ok: true };
  }

  private handleSnooze(workItemId: string, snoozeDuration?: number): ActionResult {
    const minutes = snoozeDuration ?? 60;
    const snoozedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();

    this.graph.upsertWorkItem({
      id: workItemId,
      source: "",
      snoozedUntil,
    });

    log.info("Snoozed work item", workItemId, `until ${snoozedUntil}`);
    return { ok: true };
  }
}
