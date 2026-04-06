// core/adapters/registry.ts — Adapter registry for messaging and task adapters
//
// Core code uses this registry to instantiate adapters by name instead of
// importing concrete classes directly. Each adapter module registers itself
// via registerMessagingAdapter / registerTaskAdapter at import time.

import type { MessagingAdapter } from "./messaging/interface.js";
import type { TaskAdapter } from "./tasks/interface.js";
import type { AdapterSetupInfo } from "./setup.js";

export type MessagingAdapterFactory = () => MessagingAdapter;
export type TaskAdapterFactory = () => TaskAdapter;

const messagingAdapters = new Map<string, MessagingAdapterFactory>();
const taskAdapters = new Map<string, TaskAdapterFactory>();

export function registerMessagingAdapter(name: string, factory: MessagingAdapterFactory): void {
  messagingAdapters.set(name, factory);
}

export function registerTaskAdapter(name: string, factory: TaskAdapterFactory): void {
  taskAdapters.set(name, factory);
}

export function createMessagingAdapter(name: string): MessagingAdapter {
  const factory = messagingAdapters.get(name);
  if (!factory) {
    throw new Error(`Unknown messaging adapter: "${name}". Registered: ${[...messagingAdapters.keys()].join(", ") || "(none)"}`);
  }
  return factory();
}

export function createTaskAdapter(name: string): TaskAdapter {
  const factory = taskAdapters.get(name);
  if (!factory) {
    throw new Error(`Unknown task adapter: "${name}". Registered: ${[...taskAdapters.keys()].join(", ") || "(none)"}`);
  }
  return factory();
}

export function getRegisteredMessagingAdapters(): string[] {
  return [...messagingAdapters.keys()];
}

export function getRegisteredTaskAdapters(): string[] {
  return [...taskAdapters.keys()];
}

export function getMessagingAdapterSetupInfo(): AdapterSetupInfo[] {
  return getRegisteredMessagingAdapters().map((name) => {
    const adapter = createMessagingAdapter(name);
    return adapter.getSetupInfo();
  });
}

export function getTaskAdapterSetupInfo(): AdapterSetupInfo[] {
  return getRegisteredTaskAdapters().map((name) => {
    const adapter = createTaskAdapter(name);
    return adapter.getSetupInfo();
  });
}
