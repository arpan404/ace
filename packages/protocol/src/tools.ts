import { z } from "zod";
import { AgentId, BackgroundTaskId, ItemId, Timestamp } from "./ids.ts";
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
export const ToolDetail = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shell"),
    command: z.string(),
    cwd: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    /** Accumulated output; long output may be truncated with `outputTruncated`. */
    output: z.string().optional(),
    outputTruncated: z.boolean().optional(),
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
  z.object({ kind: z.literal("plan"), markdown: z.string().optional() }),
  z.object({ kind: z.literal("ask_user") }),
  z.object({ kind: z.enum(["browser", "image", "notebook", "custom"]) }),
]);
export type ToolDetail = z.infer<typeof ToolDetail>;

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
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  /** Complete native call and result, verbatim. */
  raw: z.array(RawPayload),
});
export type ToolCall = z.infer<typeof ToolCall>;
