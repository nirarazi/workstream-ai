// core/adapters/messaging/interface.ts — MessagingAdapter interface

import type { Credentials, Thread, Message } from "../../types.js";
import type { ContextGraph } from "../../graph/index.js";
import type { Database } from "../../graph/db.js";
import type { AdapterSetupInfo } from "../setup.js";

export interface MessagingAdapter {
  name: string;
  displayName: string;

  /** Declare setup form fields for this adapter */
  getSetupInfo(): AdapterSetupInfo;

  /** Transform raw form values before connect(). If not implemented, fields are passed as-is. */
  prepareCredentials?(fields: Record<string, string>): Record<string, string>;
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

  /** True when the adapter is being rate-limited or backing off */
  readonly isThrottling?: boolean;

  /** Return platform-specific metadata (e.g. workspace URL) for the frontend */
  getMetadata?(): Record<string, unknown>;

  /** Build a URL to open a specific thread in the platform's native UI */
  buildThreadUrl?(channelId: string, threadId?: string): string | null;

  /** Serialize a user ID into the platform's native mention format (e.g. <@U123> for Slack) */
  serializeMention?(userId: string): string;

  /** Backfill agent names/avatars from platform user data. Called once after connect. */
  backfillAgents?(graph: ContextGraph): Promise<number>;

  /** Backfill platform-specific thread metadata (e.g. channel privacy). Called once after connect. */
  backfillThreads?(db: Database): Promise<number>;
}
