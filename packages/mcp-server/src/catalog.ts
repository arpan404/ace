import { z } from "zod";
import {
  McpStatus,
  Agent,
  McpNoticeInput,
  HandoffPageInput,
  HandoffPage,
  HandoffChunkInput,
  HandoffChunk,
} from "@ace/protocol";

/** Registered by the handoff owner; scope checks stay at the storage boundary. */
export const handoffToolCatalog = [
  {
    name: "ace_read_handoff",
    riskClass: "read-only",
    description:
      "Page cited handoff history. Use sourceThreadId from the manifest and itemsBefore for earlier pages.",
    input: HandoffPageInput,
    output: HandoffPage,
    // The full item union is ~57 KB of schema; agents read type, id and text parts.
    advertisedOutput: z.looseObject({
      threadId: z.string(),
      items: z.array(z.looseObject({ type: z.string(), id: z.string().optional() })),
      itemsBefore: z.number().int().positive().nullable(),
    }),
    capability: null,
    timeoutMs: 10_000,
  },
  {
    name: "ace_read_handoff_chunk",
    riskClass: "read-only",
    description:
      "Read a bounded text or shell-output stream from handoff history. Bytes are base64; decode with the returned encoding. Continue at nextOffset until eof.",
    input: HandoffChunkInput,
    output: HandoffChunk,
    capability: null,
    timeoutMs: 10_000,
  },
] as const;

const accepted = z.strictObject({
  intentId: z.string().min(1).max(256),
  accepted: z.literal(true),
});
export const AgentPageInput = z.strictObject({
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const AgentPage = z.strictObject({
  agents: z.array(Agent).max(100),
  nextCursor: z.string().max(256).nullable(),
});

/** Source of truth shared by runtime registration and the generated reference. */
export const builtinToolCatalog = [
  {
    name: "ace_list_agents",
    riskClass: "read-only",
    description: "Read a page of this thread's agent tree; status includes live descendants.",
    input: AgentPageInput,
    output: AgentPage,
    capability: null,
    timeoutMs: 10_000,
  },
  {
    name: "ace_notify_user",
    riskClass: "external-effect",
    description: "Post a notice and request a user notification.",
    input: McpNoticeInput,
    output: accepted,
    capability: "notify",
    timeoutMs: 10_000,
  },
] as const;

export const statusToolCatalog = [
  {
    name: "ace_status",
    riskClass: "read-only",
    description:
      "Describe ace, this connection, which ace tool groups are enabled, and the thread's access mode. Groups cover only ace's own tools: use your own workspace tools for files and shell. Also available as ace://status.",
    input: z.strictObject({}),
    output: McpStatus,
    capability: null,
    timeoutMs: 10_000,
  },
] as const;
