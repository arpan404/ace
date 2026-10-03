import { z } from "zod";
import {
  Agent,
  Thread,
  McpNoticeInput,
  McpSpawnInput,
  HandoffPageInput,
  HandoffPage,
  HandoffChunkInput,
  HandoffChunk,
} from "@ace/protocol";

/** Registered by the handoff owner; scope checks stay at the storage boundary. */
export const handoffToolCatalog = [
  {
    name: "ace_read_handoff",
    description:
      "Page cited handoff history. Use sourceThreadId from the manifest and itemsBefore for earlier pages.",
    input: HandoffPageInput,
    output: HandoffPage,
    capability: null,
    timeoutMs: 10_000,
  },
  {
    name: "ace_read_handoff_chunk",
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
    name: "ace_thread_info",
    description: "Read this thread and its canonical status.",
    input: z.strictObject({}),
    output: z.strictObject({ thread: Thread }),
    capability: null,
    timeoutMs: 10_000,
  },
  {
    name: "ace_list_agents",
    description: "Read a page of this thread's agent tree; status includes live descendants.",
    input: AgentPageInput,
    output: AgentPage,
    capability: null,
    timeoutMs: 10_000,
  },
  {
    name: "ace_notify_user",
    description: "Post a notice and request a user notification.",
    input: McpNoticeInput,
    output: accepted,
    capability: "notify",
    timeoutMs: 10_000,
  },
  {
    name: "ace_spawn_agent",
    description:
      "Request a child agent. Acceptance is not completion; inspect the tree for progress.",
    input: McpSpawnInput,
    output: accepted,
    capability: "agents",
    timeoutMs: 10_000,
  },
] as const;
