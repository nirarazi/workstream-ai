// core/adapters/tasks/interface.ts — TaskAdapter interface

import type { Credentials, WorkItemDetail, WorkItemComment } from "../../types.js";
import type { AdapterSetupInfo } from "../setup.js";

export interface CreateWorkItemParams {
  title: string;
  description?: string;
  projectKey: string;
  issueType?: string;
}

export interface TaskAdapter {
  name: string;
  displayName: string;

  /** Declare setup form fields for this adapter */
  getSetupInfo(): AdapterSetupInfo;

  /** Transform raw form values before connect(). If not implemented, fields are passed as-is. */
  prepareCredentials?(fields: Record<string, string>): Record<string, string>;

  /** Connect; when `signal` aborts (a newer settings save replaced this one), stop and reject. */
  connect(credentials: Credentials, signal?: AbortSignal): Promise<void>;
  /** Return the authenticated user's identity (the operator). Null if not connected or not supported. */
  getAuthenticatedUser?(): { userId: string; userName: string } | null;
  /** The tracker's item by its own key (a ticket key such as OPS-101, from the item's keys), never a work item id */
  getWorkItem(key: string): Promise<WorkItemDetail | null>;
  updateWorkItem(id: string, update: Partial<WorkItemDetail>): Promise<void>;
  searchWorkItems(query: string): Promise<WorkItemDetail[]>;
  getComments(id: string): Promise<WorkItemComment[]>;
  /** Create a new work item/ticket. Optional — not all adapters support creation. */
  createWorkItem?(params: CreateWorkItemParams): Promise<WorkItemDetail>;

  /**
   * Work item ID prefixes the tracker knows (e.g. ["OPS-", "ENG-", "MKT-"]). They're joined with
   * config.taskAdapter.ticketPrefixes; an ID matching neither, and not already a work item, is
   * discarded rather than creating a phantom work item. Called often (per extracted ID), so it must
   * answer from memory: an adapter that loads the list may return [] until it has it.
   */
  getValidIdPrefixes?(): string[];
}
