import { z } from "zod";
import { AgentId, BackgroundTaskId, ItemId, Timestamp } from "./ids.ts";
import { Attachment } from "./context.ts";
import { RawPayload } from "./provider.ts";

export const ToolKind = z.enum([
  "shell",
  "file.read",
  "file.edit",
  "file.write",
  "file.delete",
  "file.move",
  "search",
  "web.search",
  "web.fetch",
  "mcp",
  "agent.spawn",
  "agent.message",
  "todo",
  "plan",
  "ask_user",
  "browser",
  "image",
  "notebook",
  "custom",
]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ToolStatus = z.enum([
  "pending",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed",
  "declined",
  "cancelled",
]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/** A single file change, normalised from apply_patch, Edit, ACP diffs… */
export const FileChange = z.object({
  path: z.string(),
  kind: z.enum(["add", "update", "delete", "move"]),
  movePath: z.string().optional(),
  /** Unified diff when the provider sends one. */
  diff: z.string().optional(),
  oldText: z.string().nullable().optional(),
  newText: z.string().optional(),
});
export type FileChange = z.infer<typeof FileChange>;

export const TodoEntry = z.object({
  id: z.string().optional(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});
export type TodoEntry = z.infer<typeof TodoEntry>;

/**
 * Normalised view of the call, by kind. Only fields ace renders specially
 * are typed; everything else stays in `raw`.
 */
export const OutputSummary = z.object({
  streamId: z.string().min(1),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tail: z
    .string()
    .refine((text) => new TextEncoder().encode(text).length <= 4096)
    .meta({ "x-ace-constraint": "UTF-8 encoding must be at most 4096 bytes." }),
  truncated: z.boolean(),
});
export type OutputSummary = z.infer<typeof OutputSummary>;

export const ToolDetail = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shell"),
    command: z.string(),
    rawCommand: z.string().optional(),
    cwd: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    /** Full output lives in the daemon stream store. */
    output: OutputSummary.optional(),
  }),
  z.object({
    kind: z.literal("file.read"),
    path: z.string(),
    range: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
  }),
  z.object({
    kind: z.enum(["file.edit", "file.write", "file.delete", "file.move"]),
    changes: z.array(FileChange),
  }),
  z.object({
    kind: z.literal("search"),
    query: z.string(),
    path: z.string().optional(),
    matches: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("web.search"), query: z.string() }),
  z.object({ kind: z.literal("web.fetch"), url: z.string() }),
  z.object({
    kind: z.literal("mcp"),
    server: z.string(),
    tool: z.string(),
    arguments: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("agent.spawn"),
    description: z.string().optional(),
    prompt: z.string().optional(),
    agentType: z.string().optional(),
    childAgentId: AgentId.optional(),
  }),
  z.object({
    kind: z.literal("agent.message"),
    targetAgentId: AgentId.optional(),
    message: z.string().optional(),
  }),
  z.object({ kind: z.literal("todo"), todos: z.array(TodoEntry) }),
  z.object({
    kind: z.literal("plan"),
    markdown: z.string().optional(),
    todos: z.array(TodoEntry).optional(),
  }),
  z.object({ kind: z.literal("ask_user") }),
  z.object({ kind: z.enum(["browser", "image", "notebook", "custom"]) }),
]);
export type ToolDetail = z.infer<typeof ToolDetail>;

/** Daemon-captured ace results; images use thread-owned attachment endpoints. */
export const ToolResult = z.object({
  isError: z.boolean(),
  content: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string().max(32_768) }),
        z.object({ type: z.literal("image"), attachment: Attachment }),
      ]),
    )
    .max(16),
  structuredContent: z.unknown().optional(),
  durationMs: z.number().finite().nonnegative(),
  target: z
    .object({
      bundleId: z.string().max(256),
      windowId: z.number().int().nonnegative().optional(),
      displayName: z.string().max(256),
    })
    .optional(),
  mode: z.enum(["background", "foreground"]).optional(),
  scale: z.number().positive().finite().optional(),
  size: z
    .object({
      width: z.number().int().positive().max(16_384),
      height: z.number().int().positive().max(16_384),
    })
    .optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const ToolCall = z.object({
  id: ItemId,
  agentId: AgentId,
  kind: ToolKind,
  /** Human-readable one-liner, e.g. "Read src/math.ts". */
  title: z.string(),
  status: ToolStatus,
  detail: ToolDetail,
  /** Set when the call outlives the turn (background shell, background subagent). */
  backgroundTaskId: BackgroundTaskId.optional(),
  error: z.string().optional(),
  result: ToolResult.optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  /** Complete native call and result, verbatim. */
  raw: z.array(RawPayload),
});
export type ToolCall = z.infer<typeof ToolCall>;
