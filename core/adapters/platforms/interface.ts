// core/adapters/platforms/interface.ts — PlatformAdapter interface

import type { Credentials, Thread, Message } from "../../types.js";

export interface PlatformAdapter {
  name: string;
  connect(credentials: Credentials): Promise<void>;
  readThreads(since: Date, channels?: string[]): Promise<Thread[]>;
  replyToThread(threadId: string, channelId: string, message: string): Promise<void>;
  streamMessages(handler: (msg: Message) => void): void;
  getUsers(): Promise<Map<string, string>>; // userId -> displayName
  getThreadMessages(threadId: string, channelId: string): Promise<Message[]>;
}
