// core/adapters/tasks/interface.ts — TaskAdapter interface

import type { Credentials, WorkItemDetail, WorkItemComment } from "../../types.js";

export interface TaskAdapter {
  name: string;
  connect(credentials: Credentials): Promise<void>;
  getWorkItem(id: string): Promise<WorkItemDetail | null>;
  updateWorkItem(id: string, update: Partial<WorkItemDetail>): Promise<void>;
  searchWorkItems(query: string): Promise<WorkItemDetail[]>;
  getComments(id: string): Promise<WorkItemComment[]>;
}
