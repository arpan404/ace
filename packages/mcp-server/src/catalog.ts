import { z } from "zod";
import { McpNoticeInput, ThreadId } from "@ace/protocol";

export const HandoffReadInput = z.strictObject({
  sourceThreadId: ThreadId.describe("From the handoff manifest."),
  before: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe("The previous page's itemsBefore."),
  limit: z.number().int().min(1).max(50).default(50).describe("Items per page."),
  streamId: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe("Read a cited stream instead of items."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("With streamId: from nextOffset."),
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
      "Read the history a handoff from another provider cites, newest first; page back with before = itemsBefore. With streamId: a cited text or shell stream as base64, continued at nextOffset until eof.",
    input: HandoffReadInput,
    output: z.looseObject({
      threadId: z.string().optional(),
      // The full item union is ~57 KB of schema; agents read type, id and text parts.
      items: z.array(z.looseObject({ type: z.string(), id: z.string().optional() })).optional(),
      itemsBefore: z.number().int().positive().nullable().optional(),
      omitted: z.array(z.looseObject({ itemId: z.string(), dropped: z.string() })).optional(),
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
      "Notify the person of something they should see while away, such as a long task finishing or a decision needed; it also posts on this thread.",
    input: z.strictObject({
      text: McpNoticeInput.shape.text.describe("What happened, in a sentence or two."),
      level: McpNoticeInput.shape.level.describe("info (default), warning or error."),
    }),
    output: accepted,
    capability: "notify",
    timeoutMs: 10_000,
  },
] as const;
