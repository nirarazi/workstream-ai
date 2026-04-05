// core/adapters/platforms/interface.ts — PlatformAdapter interface

import type { Credentials, Thread, Message } from "../../types.js";

export interface PlatformAdapter {
  name: string;
  displayName: string;
  connect(credentials: Credentials): Promise<void>;
  readThreads(since: Date, channels?: string[]): Promise<Thread[]>;
  replyToThread(threadId: string, channelId: string, message: string): Promise<void>;
  /** Post a new top-level message in a channel (not a reply) */
  postMessage(channelId: string, message: string): Promise<{ threadId: string }>;
  /** Open/get a DM channel with a user and post a message */
  sendDirectMessage(userId: string, message: string): Promise<{ channelId: string; threadId: string }>;
  streamMessages(handler: (msg: Message) => void): void;
  getUsers(): Promise<Map<string, string>>; // userId -> displayName
  getThreadMessages(threadId: string, channelId: string): Promise<Message[]>;

  /** Parse a platform-specific thread URL into threadId + channelId. Returns null if URL format is not recognized. */
  parseThreadUrl?(url: string): { threadId: string; channelId: string } | null;
}
