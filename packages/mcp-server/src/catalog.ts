import { z } from "zod";
import { McpNoticeInput, ThreadId } from "@ace/protocol";

export const HandoffReadInput = z.strictObject({
  sourceThreadId: ThreadId.describe("The sourceThreadId from the handoff manifest."),
  before: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe("The previous page's itemsBefore, for earlier items."),
  limit: z.number().int().min(1).max(50).default(50).describe("Items per page, 1 to 50."),
  streamId: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe("Read a cited text or shell-output stream instead of items."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("With streamId: byte offset, from nextOffset."),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(32_768)
    .default(32_768)
    .describe("With streamId: bytes to read."),
});
export type HandoffReadInput = z.output<typeof HandoffReadInput>;

/** Registered by the handoff owner; scope checks stay at the storage boundary. */
export const handoffToolCatalog = [
  {
    name: "handoff_read",
    title: "Read handoff history",
    toolset: "ace-threads",
    riskClass: "read-only",
    description:
      "Page the history cited by a handoff from another provider: items newest first (before = itemsBefore for earlier ones), or with streamId a bounded text or shell-output stream as base64 in the returned encoding, continued at nextOffset until eof.",
    input: HandoffReadInput,
    output: z.looseObject({
      threadId: z.string().optional(),
      // The full item union is ~57 KB of schema; agents read type, id and text parts.
      items: z.array(z.looseObject({ type: z.string(), id: z.string().optional() })).optional(),
      itemsBefore: z.number().int().positive().nullable().optional(),
      bytes: z.string().optional(),
      encoding: z.enum(["utf-16le", "utf-8"]).optional(),
      nextOffset: z.number().int().nonnegative().optional(),
      eof: z.boolean().optional(),
    }),
    capability: null,
    timeoutMs: 10_000,
  },
] as const;

const accepted = z.strictObject({
  intentId: z.string().min(1).max(256),
  accepted: z.literal(true),
});

/** Source of truth shared by runtime registration and the generated reference. */
export const builtinToolCatalog = [
  {
    name: "notify",
    title: "Notify the person",
    toolset: "ace-threads",
    riskClass: "thread-write",
    openWorld: false,
    description:
      "Post a notice on this thread and send the person a notification, for something they should see while away (a long task finished, a decision is needed).",
    input: z.strictObject({
      text: McpNoticeInput.shape.text.describe("What happened, in one or two sentences."),
      level: McpNoticeInput.shape.level.describe("info (default), warning or error."),
    }),
    output: accepted,
    capability: "notify",
    timeoutMs: 10_000,
  },
] as const;
