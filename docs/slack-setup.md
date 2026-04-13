# Slack Setup Guide

This guide covers how to connect workstream.ai to your Slack workspace, with special attention to how Slack treats messages from apps — a critical detail for agent fleet operators.

## Prerequisites

- A Slack workspace where your agents operate
- Admin or Owner permissions to install Slack apps
- Your agent fleet's gateway (e.g., OpenClaw) configured and running

## 1. Create the workstream.ai Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From scratch**
2. Name it `workstream.ai` (or any name you prefer)
3. Select your workspace

### Required User Token Scopes

Under **OAuth & Permissions**, add these **User Token Scopes** (not Bot Token Scopes):

| Scope | Purpose |
|---|---|
| `channels:history` | Read messages in public channels |
| `channels:read` | List public channels |
| `groups:history` | Read messages in private channels |
| `groups:read` | List private channels |
| `im:history` | Read direct messages |
| `im:read` | List DM conversations |
| `users:read` | Resolve agent names and avatars |
| `chat:write` | Send replies as the operator |

### Install and Get Your Token

1. Click **Install to Workspace** and authorize
2. Copy the **User OAuth Token** (starts with `xoxp-`)
3. Add it to your `.env` file:

```
WORKSTREAM_SLACK_TOKEN=xoxp-your-token-here
```

## 2. How Slack Treats Messages from Apps

**This is the most important section for agent fleet operators.**

Even though workstream.ai uses your personal user token (`xoxp-`), Slack associates every message sent through an app's token with that app's identity. This means:

- Messages you send via workstream.ai will show **your name and avatar** in Slack
- However, the underlying message event includes a `bot_id` and `app_id` field identifying the workstream.ai Slack app
- **Most bot frameworks filter out messages that have `bot_id` set**, to prevent infinite loops between bots

This is a Slack platform behavior, not a workstream.ai limitation. There is no API parameter or token type that avoids it — any token issued through a Slack app's OAuth flow will have the app identity stamped on every message.

### What this means in practice

When you type a reply in workstream.ai:
- It appears in Slack as a message from you (e.g., "Nir Arazi")
- Humans in the thread see it normally and can respond
- **Agents may not see it** unless they are explicitly configured to process messages from apps

When you @-mention an agent in your reply (e.g., `@Levy approve this`):
- The agent receives a mention notification
- Most agent frameworks process mentions regardless of `bot_id`
- This is the reliable way to direct a reply to a specific agent

## 3. Configuring Your Agents to See workstream.ai Messages

For your agent fleet to respond to messages sent via workstream.ai, you need to configure your agent gateway to **not ignore messages from the workstream.ai app when the agent is mentioned**.

### OpenClaw

In your fleet configuration, enable the setting for agents to respond to bot/app messages in threads when they are mentioned. This ensures that when you @-mention an agent in a workstream.ai reply, the agent processes the message as if you had typed it directly in Slack.

### General Guidance for Other Frameworks

If you manage your own bot code, check your message event handler for filters like:

```python
# Common bot-loop prevention — too aggressive for fleet operators
if event.get("bot_id"):
    return  # This will also ignore workstream.ai messages!
```

Instead, use a more targeted filter:

```python
# Better: ignore messages from THIS bot only, not all apps
if event.get("bot_id") == MY_OWN_BOT_ID:
    return

# Or: always process messages where this bot is mentioned
if bot_is_mentioned(event):
    process(event)  # Even if bot_id is set
```

The workstream.ai Slack app's identity can be found in the response from `auth.test` or in your Slack app's settings page under **Basic Information**.

## 4. Verifying the Setup

After configuring workstream.ai and your agent gateway:

1. Open workstream.ai and find an active work item with an agent thread
2. Type a reply that @-mentions the agent (e.g., `@Levy what's the status?`)
3. Verify in Slack that:
   - The message appears with your name and avatar
   - The agent responds to your message

If the agent does not respond:
- Check that your agent gateway allows processing of app-originated messages when the agent is mentioned
- Verify the agent is healthy and monitoring that channel/thread
- Check the agent's logs for any message filtering that might be dropping the event

## 5. Best Practices

- **@-mention agents when you need a response.** General comments like "this issue is now resolved" don't need a mention — they're for the thread's human readers.
- **Use the reply input for instructions.** workstream.ai's reply bar posts directly to the Slack thread. Combined with action buttons (Unblock, Done, Dismiss), this covers most operator workflows.
- **One workspace per workstream.ai instance.** Each instance connects to a single Slack workspace with a single operator token.
