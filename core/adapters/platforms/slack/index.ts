// core/adapters/platforms/slack/index.ts — Slack platform adapter

import { WebClient } from "@slack/web-api";
import type { PlatformAdapter } from "../interface.js";
import type { Credentials, Thread, Message } from "../../../types.js";
import { createLogger } from "../../../logger.js";

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
}

interface SlackUser {
  id?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
  };
}

async function withRateLimitRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { code?: string; data?: { retryAfter?: number }; retryAfter?: number };
      if (
        error.code === "slack_webapi_rate_limited" ||
        (error.code === "slack_webapi_platform_error" && error.data?.retryAfter)
      ) {
        if (attempt >= RATE_LIMIT_MAX_RETRIES) {
          log.error(`Rate limited on ${context} after ${RATE_LIMIT_MAX_RETRIES} retries`);
          throw err;
        }
        const retryAfter = error.data?.retryAfter ?? error.retryAfter ?? 1;
        log.warn(`Rate limited on ${context}, retrying after ${retryAfter}s (attempt ${attempt + 1})`);
        await sleep(retryAfter * 1000);
      } else {
        throw err;
      }
    }
  }
  // Unreachable, but TypeScript needs it
  throw new Error(`Rate limit retries exhausted for ${context}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlackAdapter implements PlatformAdapter {
  readonly name = "slack";
  private client: WebClient | null = null;
  private userMap: Map<string, string> = new Map();
  private channelMap: Map<string, string> = new Map(); // channelId -> channelName
  private messageHandler: ((msg: Message) => void) | null = null;

  async connect(credentials: Credentials): Promise<void> {
    const token = credentials.token;
    if (!token || !token.startsWith("xoxp-")) {
      throw new Error("Slack adapter requires an xoxp- user token");
    }

    this.client = new WebClient(token);

    try {
      const authResult = await this.client.auth.test();
      log.info(`Connected to Slack as ${authResult.user} (team: ${authResult.team})`);
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
      const channelName = this.channelMap.get(channelId) ?? channelId;

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
    );

    log.info(`Replied to thread ${threadId} in channel ${channelId}`);
  }

  streamMessages(handler: (msg: Message) => void): void {
    this.messageHandler = handler;
    log.info("Message handler registered (will fire on next readThreads poll)");
  }

  async getUsers(): Promise<Map<string, string>> {
    this.ensureConnected();
    await this.fetchUsers();
    return new Map(this.userMap);
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
    for (const [id, name] of this.channelMap) {
      nameToId.set(name, id);
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
      );

      const channels = (result.channels ?? []) as SlackChannel[];
      for (const ch of channels) {
        if (ch.id && ch.name) {
          this.channelMap.set(ch.id, ch.name);
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
      );

      const messages = (result.messages ?? []) as SlackMessage[];
      allMessages.push(...messages);

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    return allMessages;
  }

  private async fetchUsers(): Promise<void> {
    let cursor: string | undefined;
    this.userMap.clear();

    do {
      const result = await withRateLimitRetry(
        () =>
          this.client!.users.list({
            limit: DEFAULT_PAGE_LIMIT,
            cursor: cursor || undefined,
          }),
        "users.list",
      );

      const members = (result.members ?? []) as SlackUser[];
      for (const member of members) {
        if (member.id) {
          const displayName =
            member.profile?.display_name || member.real_name || member.id;
          this.userMap.set(member.id, displayName);
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
    const messages: Message[] = slackMessages.map((msg) => ({
      id: msg.ts ?? "",
      threadId: threadTs,
      channelId,
      channelName,
      userId: msg.user ?? "",
      userName: this.userMap.get(msg.user ?? "") ?? msg.user ?? "unknown",
      text: msg.text ?? "",
      timestamp: msg.ts ?? "",
      platform: "slack",
    }));

    const lastMessage = messages[messages.length - 1];

    return {
      id: threadTs,
      channelId,
      channelName,
      platform: "slack",
      workItemId: null,
      lastActivity: lastMessage?.timestamp ?? threadTs,
      messageCount: messages.length,
      messages,
    };
  }
}
