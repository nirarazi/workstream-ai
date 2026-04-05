// core/adapters/platforms/slack/index.ts — Slack platform adapter

import { WebClient } from "@slack/web-api";
import type { PlatformAdapter } from "../interface.js";
import type { Credentials, Thread, Message } from "../../../types.js";
import { createLogger } from "../../../logger.js";
import { SlackRateLimiter } from "./rate-limiter.js";

const log = createLogger("slack-adapter");

const RATE_LIMIT_MAX_RETRIES = 3;
const DEFAULT_PAGE_LIMIT = 200;

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  text?: string;
  user?: string;
  subtype?: string;
}

interface SlackChannel {
  id?: string;
  name?: string;
  is_private?: boolean;
}

interface SlackUser {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    image_48?: string;
  };
}

/** Resolved user info: display name + avatar URL */
interface UserInfo {
  name: string;
  avatar: string;
}

/** Convert a Slack epoch timestamp (e.g. "1711234567.123456") to ISO 8601 */
function slackTsToISO(ts: string): string {
  const epoch = parseFloat(ts);
  if (Number.isNaN(epoch)) return ts;
  return new Date(epoch * 1000).toISOString();
}

/**
 * Execute a Slack API call with per-method rate limiting and 429 retry.
 *
 * Flow:
 * 1. Acquire a slot in the per-method bucket (blocks if bucket is full or
 *    a global 429 backoff is active)
 * 2. Lock the method (serializes concurrent calls to the same method)
 * 3. Execute the call
 * 4. On 429: report to global backoff, wait, retry (up to max retries)
 * 5. Release the lock on completion
 */
async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  method: string,
  limiter: SlackRateLimiter,
): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    // Acquire a slot (waits for per-method bucket + global backoff)
    await limiter.acquire(method);
    const release = limiter.lock(method);

    try {
      const result = await fn();
      release();
      return result;
    } catch (err: unknown) {
      release();

      const error = err as { code?: string; data?: { retryAfter?: number }; retryAfter?: number };
      if (
        error.code === "slack_webapi_rate_limited" ||
        (error.code === "slack_webapi_platform_error" && error.data?.retryAfter)
      ) {
        const retryAfter = error.data?.retryAfter ?? error.retryAfter ?? 1;

        // Report 429 to the global backoff — pauses ALL methods
        limiter.report429(retryAfter);

        if (attempt >= RATE_LIMIT_MAX_RETRIES) {
          log.error(`Rate limited on ${method} after ${RATE_LIMIT_MAX_RETRIES} retries`);
          throw err;
        }
        log.warn(`Rate limited on ${method}, retrying after ${retryAfter}s (attempt ${attempt + 1})`);
        await sleep(retryAfter * 1000);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Rate limit retries exhausted for ${method}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlackAdapter implements PlatformAdapter {
  readonly name = "slack";
  readonly displayName = "Slack";
  private client: WebClient | null = null;
  private userInfoMap: Map<string, UserInfo> = new Map();
  private channelMap: Map<string, { name: string; isPrivate: boolean }> = new Map();
  private messageHandler: ((msg: Message) => void) | null = null;
  private limiter = new SlackRateLimiter();
  private workspaceUrl: string | null = null;

  /** @deprecated The Slack adapter now manages its own per-method rate limiting internally. */
  setRateLimiter(_limiter: unknown): void {
    // No-op — kept for backwards compatibility with server.ts wiring.
    // The Slack adapter uses its own SlackRateLimiter with per-method
    // buckets matching Slack's actual tier limits.
  }

  /** True when any Slack API method bucket is full or a 429 backoff is active */
  get isThrottling(): boolean {
    return this.limiter.isThrottling;
  }

  async connect(credentials: Credentials): Promise<void> {
    const token = credentials.token;
    if (!token || !token.startsWith("xoxp-")) {
      throw new Error("Slack adapter requires an xoxp- user token");
    }

    // Disable the SDK's built-in automatic retries on 429 — we handle
    // rate limiting ourselves with per-method buckets and global backoff.
    this.client = new WebClient(token, {
      retryConfig: { retries: 0 },
    });

    try {
      const authResult = await this.client.auth.test();
      // Store workspace URL for constructing Slack links (e.g. channel URLs)
      this.workspaceUrl = (authResult.url as string | undefined)?.replace(/\/+$/, "") ?? null;
      log.info(`Connected to Slack as ${authResult.user} (team: ${authResult.team})`);

      // Pre-fetch user and channel lists so names, avatars, and privacy flags
      // are available for thread building and backfill
      await this.fetchUsers();
      log.info(`Loaded ${this.userInfoMap.size} Slack users`);
      await this.fetchChannelList();
      log.info(`Loaded ${this.channelMap.size} Slack channels`);
    } catch (err: unknown) {
      this.client = null;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Slack auth failed: ${message}`);
    }
  }

  async readThreads(since: Date, channels?: string[]): Promise<Thread[]> {
    this.ensureConnected();

    const channelIds = channels?.length
      ? await this.resolveChannelIds(channels)
      : await this.getAllChannelIds();

    const threads: Thread[] = [];
    const oldest = String(since.getTime() / 1000);

    for (const channelId of channelIds) {
      const channelInfo = this.channelMap.get(channelId);
      const channelName = channelInfo?.name ?? channelId;

      const messages = await this.fetchChannelHistory(channelId, oldest);

      for (const msg of messages) {
        if (!msg.ts || msg.subtype === "channel_join" || msg.subtype === "channel_leave") {
          continue;
        }

        if (msg.reply_count && msg.reply_count > 0 && msg.thread_ts) {
          // This is a parent message with replies — fetch the full thread
          const replyMessages = await this.fetchThreadReplies(channelId, msg.thread_ts);
          const thread = this.buildThread(channelId, channelName, msg.thread_ts, replyMessages);
          threads.push(thread);
        } else if (!msg.thread_ts || msg.thread_ts === msg.ts) {
          // Standalone message (no replies, not a reply itself)
          const thread = this.buildThread(channelId, channelName, msg.ts, [msg]);
          threads.push(thread);
        }
        // If msg.thread_ts !== msg.ts and no reply_count, it's a reply — skip it,
        // we'll pick it up when processing the parent message.
      }
    }

    // Notify handler of new messages if registered
    if (this.messageHandler) {
      for (const thread of threads) {
        for (const message of thread.messages) {
          this.messageHandler(message);
        }
      }
    }

    return threads;
  }

  async replyToThread(threadId: string, channelId: string, message: string): Promise<void> {
    this.ensureConnected();

    await withRateLimitRetry(
      () =>
        this.client!.chat.postMessage({
          channel: channelId,
          text: message,
          thread_ts: threadId,
          as_user: true,
        }),
      "chat.postMessage",
      this.limiter,
    );

    log.info(`Replied to thread ${threadId} in channel ${channelId}`);
  }

  async postMessage(channelId: string, message: string): Promise<{ threadId: string }> {
    this.ensureConnected();

    const result = await withRateLimitRetry(
      () =>
        this.client!.chat.postMessage({
          channel: channelId,
          text: message,
          as_user: true,
        }),
      "chat.postMessage",
      this.limiter,
    );

    const ts = (result as { ts?: string }).ts ?? "";
    log.info(`Posted message to channel ${channelId}, ts=${ts}`);
    return { threadId: ts };
  }

  async sendDirectMessage(userId: string, message: string): Promise<{ channelId: string; threadId: string }> {
    this.ensureConnected();

    const openResult = await withRateLimitRetry(
      () => this.client!.conversations.open({ users: userId }),
      "conversations.open",
      this.limiter,
    );

    const dmChannelId = (openResult as { channel?: { id?: string } }).channel?.id;
    if (!dmChannelId) {
      throw new Error(`Failed to open DM with user ${userId}`);
    }

    const postResult = await withRateLimitRetry(
      () =>
        this.client!.chat.postMessage({
          channel: dmChannelId,
          text: message,
          as_user: true,
        }),
      "chat.postMessage",
      this.limiter,
    );

    const ts = (postResult as { ts?: string }).ts ?? "";
    log.info(`Sent DM to ${userId} in channel ${dmChannelId}, ts=${ts}`);
    return { channelId: dmChannelId, threadId: ts };
  }

  streamMessages(handler: (msg: Message) => void): void {
    this.messageHandler = handler;
    log.info("Message handler registered (will fire on next readThreads poll)");
  }

  async getUsers(): Promise<Map<string, string>> {
    this.ensureConnected();
    await this.fetchUsers();
    // Return name-only map for backwards compatibility
    const nameMap = new Map<string, string>();
    for (const [id, info] of this.userInfoMap) {
      nameMap.set(id, info.name);
    }
    return nameMap;
  }

  async getThreadMessages(threadId: string, channelId: string): Promise<Message[]> {
    this.ensureConnected();

    const channelInfo = this.channelMap.get(channelId);
    const channelName = channelInfo?.name ?? channelId;

    const slackMessages = await this.fetchThreadReplies(channelId, threadId);

    return slackMessages.map((msg) => {
      const userInfo = this.userInfoMap.get(msg.user ?? "");
      return {
        id: msg.ts ?? "",
        threadId,
        channelId,
        channelName,
        userId: msg.user ?? "",
        userName: userInfo?.name ?? msg.user ?? "unknown",
        userAvatarUrl: userInfo?.avatar || undefined,
        text: this.resolveSlackMentions(msg.text ?? ""),
        timestamp: msg.ts ? slackTsToISO(msg.ts) : "",
        platform: "slack",
      };
    });
  }

  /** Get avatar URL for a user ID, or empty string if unknown */
  getUserAvatar(userId: string): string {
    return this.userInfoMap.get(userId)?.avatar ?? "";
  }

  /** Get workspace URL (e.g. "https://myteam.slack.com") for link construction */
  getWorkspaceUrl(): string | null {
    return this.workspaceUrl;
  }

  /** Check if a channel is private */
  isChannelPrivate(channelId: string): boolean {
    return this.channelMap.get(channelId)?.isPrivate ?? false;
  }

  // --- Private helpers ---

  private ensureConnected(): asserts this is { client: WebClient } {
    if (!this.client) {
      throw new Error("Slack adapter not connected. Call connect() first.");
    }
  }

  private async resolveChannelIds(channelNames: string[]): Promise<string[]> {
    // Fetch channel list and resolve names to IDs
    await this.fetchChannelList();

    const nameToId = new Map<string, string>();
    for (const [id, info] of this.channelMap) {
      nameToId.set(info.name, id);
    }

    const ids: string[] = [];
    for (const name of channelNames) {
      const cleanName = name.startsWith("#") ? name.slice(1) : name;
      const id = nameToId.get(cleanName);
      if (id) {
        ids.push(id);
      } else {
        log.warn(`Channel not found: ${name}`);
      }
    }

    return ids;
  }

  private async getAllChannelIds(): Promise<string[]> {
    await this.fetchChannelList();
    return Array.from(this.channelMap.keys());
  }

  private async fetchChannelList(): Promise<void> {
    let cursor: string | undefined;
    this.channelMap.clear();

    do {
      const result = await withRateLimitRetry(
        () =>
          this.client!.conversations.list({
            types: "public_channel,private_channel",
            exclude_archived: true,
            limit: DEFAULT_PAGE_LIMIT,
            cursor: cursor || undefined,
          }),
        "conversations.list",
        this.limiter,
      );

      const channels = (result.channels ?? []) as SlackChannel[];
      for (const ch of channels) {
        if (ch.id && ch.name) {
          this.channelMap.set(ch.id, { name: ch.name, isPrivate: ch.is_private ?? false });
        }
      }

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }

  private async fetchChannelHistory(channelId: string, oldest: string): Promise<SlackMessage[]> {
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      const result = await withRateLimitRetry(
        () =>
          this.client!.conversations.history({
            channel: channelId,
            oldest,
            limit: DEFAULT_PAGE_LIMIT,
            cursor: cursor || undefined,
          }),
        "conversations.history",
        this.limiter,
      );

      const messages = (result.messages ?? []) as SlackMessage[];
      allMessages.push(...messages);

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    return allMessages;
  }

  private async fetchThreadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      const result = await withRateLimitRetry(
        () =>
          this.client!.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: DEFAULT_PAGE_LIMIT,
            cursor: cursor || undefined,
          }),
        "conversations.replies",
        this.limiter,
      );

      const messages = (result.messages ?? []) as SlackMessage[];
      allMessages.push(...messages);

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    return allMessages;
  }

  private async fetchUsers(): Promise<void> {
    let cursor: string | undefined;
    this.userInfoMap.clear();

    do {
      const result = await withRateLimitRetry(
        () =>
          this.client!.users.list({
            limit: DEFAULT_PAGE_LIMIT,
            cursor: cursor || undefined,
          }),
        "users.list",
        this.limiter,
      );

      const members = (result.members ?? []) as SlackUser[];
      for (const member of members) {
        if (member.id) {
          // Bots/apps often have no display_name — fall through to real_name, profile.real_name, or member.name
          const displayName =
            member.profile?.display_name ||
            member.real_name ||
            member.profile?.real_name ||
            member.name ||
            member.id;
          this.userInfoMap.set(member.id, {
            name: displayName,
            avatar: member.profile?.image_48 ?? "",
          });
        }
      }

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }

  private buildThread(
    channelId: string,
    channelName: string,
    threadTs: string,
    slackMessages: SlackMessage[],
  ): Thread {
    const messages: Message[] = slackMessages.map((msg) => {
      const userInfo = this.userInfoMap.get(msg.user ?? "");
      return {
        id: msg.ts ?? "",
        threadId: threadTs,
        channelId,
        channelName,
        userId: msg.user ?? "",
        userName: userInfo?.name ?? msg.user ?? "unknown",
        userAvatarUrl: userInfo?.avatar || undefined,
        text: this.resolveSlackMentions(msg.text ?? ""),
        timestamp: msg.ts ? slackTsToISO(msg.ts) : "",
        platform: "slack",
      };
    });

    const lastMessage = messages[messages.length - 1];

    return {
      id: threadTs,
      channelId,
      channelName,
      platformMeta: { isPrivate: this.channelMap.get(channelId)?.isPrivate ?? false },
      platform: "slack",
      workItemId: null,
      lastActivity: lastMessage?.timestamp ?? (threadTs ? slackTsToISO(threadTs) : ""),
      messageCount: messages.length,
      messages,
    };
  }

  /** Replace bare <@USERID> mentions with <@USERID|displayName> so downstream renderers can show names */
  private resolveSlackMentions(text: string): string {
    return text.replace(/<@([A-Z0-9]+)>/g, (_match, userId: string) => {
      const info = this.userInfoMap.get(userId);
      if (info) return `<@${userId}|${info.name}>`;
      return _match; // leave as-is if user unknown
    });
  }
}
