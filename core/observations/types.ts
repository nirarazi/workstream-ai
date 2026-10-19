// core/observations/types.ts — L0 observations: what was seen, normalised, append-only (docs/work-model.md, section 3)
//
// An observation is evidence: a message, a tracker or forge event, or an agent's MCP report. Adapters produce them
// (core never parses platform markup); the engine stores each once, by its dedupeKey, and assigns its id.

/** Someone on a platform, by the platform's own id */
export interface Handle {
  platform: string;
  id: string;
}

export type ObservationKind = "message" | "tracker_event" | "forge_event" | "agent_report";

export interface ObservationDraft {
  /** The platform's own id, namespaced: "slack:<workspace>/<channel>/<ts>"; "mcp-report:<id>" for an MCP report */
  dedupeKey: string;
  kind: ObservationKind;
  platform: string;
  /** ISO 8601 */
  occurredAt: string;
  /** A channel, a mailbox, a repo */
  container: { kind: string; id: string; name?: string };
  /** The platform's id for the message within its container (a Slack ts) */
  messageId: string;
  /** Verified by the adapter, except an agent_report's (an agent says who it is) */
  author: Handle;
  /** Who the message names (mentions), not who read it */
  participants: Handle[];
  senderKind: "agent" | "human" | "notification" | "unknown";
  parts: {
    /** What the author wrote, without quoted text */
    own: string;
    /** Quoted text: who wrote it is a claim, never verified */
    quoted: Array<{ text: string; claimedAuthor?: Handle }>;
    forwarded: Array<{ text: string; claimedAuthor?: Handle; dedupeKey?: string }>;
  };
  /** Other observations, by dedupeKey */
  refs: { repliesTo?: string; quotes: string[]; forwards: string[] };
  /** Links in the message (outside the platform, or to messages it can't key) */
  externalRefs: Array<{ kind: string; value: string; url?: string }>;
}

/** How one observation refers to another (an edge in observation_refs) */
export type ObservationRefKind = "replies_to" | "quotes" | "forwards";

export interface Observation extends ObservationDraft {
  /** Assigned by the engine (a ULID) */
  id: string;
}
