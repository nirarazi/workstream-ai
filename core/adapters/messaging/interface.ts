// core/adapters/messaging/interface.ts — MessagingAdapter interface

import type { Credentials, Thread, Message, KnownThread } from "../../types.js";
import type { ContextGraph } from "../../graph/index.js";
import type { Database } from "../../graph/db.js";
import type { AdapterSetupInfo } from "../setup.js";

/** Optional hints for readThreads; an adapter that ignores them still works, it just misses late replies. */
export interface ReadThreadsOptions {
  /**
   * Threads already processed, keyed by thread id. The adapter returns a known thread again, with all its
   * messages, when it has a reply after `latestAt` or more messages than `messageCount` (one was missed, e.g. it
   * failed to classify), even if the thread started before the channel's cursor. A known thread with nothing new
   * may be returned without its replies, to save platform calls. Unknown threads older than the cursor are never
   * returned.
   */
  knownThreads?: Map<string, KnownThread>;
  /** How far back (thread start) to look for late replies to known threads. */
  replyWindowStart?: Date;
}

export interface MessagingAdapter {
  name: string;
  displayName: string;

  /** Declare setup form fields for this adapter */
  getSetupInfo(): AdapterSetupInfo;

  /** Transform raw form values before connect(). If not implemented, fields are passed as-is. */
  prepareCredentials?(fields: Record<string, string>): Record<string, string>;
  /**
   * Connect and load what the adapter needs. When `signal` aborts (a newer settings save replaced this one), stop
   * making platform calls and reject; the engine never uses an adapter whose connect didn't finish.
   */
  connect(credentials: Credentials, signal?: AbortSignal): Promise<void>;
  readThreads(
    since: Date,
    channels?: string[],
    perChannelSince?: Map<string, Date>,
    options?: ReadThreadsOptions,
  ): Promise<Thread[]>;
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

  /** Display name of a user from the adapter's already-loaded directory, without a network call. Null if unknown. */
  getUserName?(userId: string): string | null;

  /** Return the authenticated user's identity (the operator). Null if not connected or not supported. */
  getAuthenticatedUser?(): { userId: string; userName: string } | null;

  /** Backfill agent names/avatars from platform user data. Called once after connect. */
  backfillAgents?(graph: ContextGraph): Promise<number>;

  /** Backfill platform-specific thread metadata (e.g. channel privacy). Called once after connect. */
  backfillThreads?(db: Database): Promise<number>;
}
