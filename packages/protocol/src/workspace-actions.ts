import { DeckOwnership } from "./deck-ownership.ts";
import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { ForgePrStatus } from "./forge.ts";
import { Run } from "./thread.ts";
import { ThreadDetails } from "./thread-client.ts";
const id = z.string().min(1).max(128);
export const WorkspaceScript = z.object({
  id,
  name: z.string().max(256),
  source: z.enum(["package.json", "Procfile", "Makefile", "justfile"]),
  command: z.string().max(8192),
});
export type WorkspaceScript = z.infer<typeof WorkspaceScript>;
export const InstalledEditor = z.object({
  id,
  name: z.string().max(256),
  command: z.string().max(4096),
});
export type InstalledEditor = z.infer<typeof InstalledEditor>;
export const EditorLaunch = z.object({ editor: InstalledEditor, path: z.string().max(4096) });
export const WorkspaceActionRequest = z.object({
  type: z.literal("workspace.request"),
  requestId: id,
  operation: z.discriminatedUnion("op", [
    z.object({
      op: z.literal("workspaces.list"),
      after: id.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    z.object({ op: z.literal("scripts.list"), threadId: ThreadId }),
    z.object({ op: z.literal("editors.list") }),
    z.object({ op: z.literal("branches.list"), workspaceId: WorkspaceId }),
    z.object({ op: z.literal("thread.details"), threadId: ThreadId }),
    z.object({ op: z.literal("pr.status"), threadId: ThreadId }),
    z.object({
      op: z.literal("runs.list"),
      threadId: ThreadId,
      before: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .default(Number.MAX_SAFE_INTEGER),
      limit: z.number().int().min(1).max(100).default(50),
    }),
  ]),
});
export type WorkspaceActionRequest = z.infer<typeof WorkspaceActionRequest>;
export const WorkspaceActionResult = z.object({
  type: z.literal("workspace.result"),
  requestId: id,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scripts"), scripts: z.array(WorkspaceScript).max(256) }),
    z.object({ kind: z.literal("editors"), editors: z.array(InstalledEditor).max(32) }),
    z.object({
      kind: z.literal("branches"),
      branches: z.array(z.string().max(1024)).max(1000),
      truncated: z.boolean(),
    }),
    z.object({ kind: z.literal("details"), details: ThreadDetails }),
    z.object({ kind: z.literal("pr"), status: ForgePrStatus.nullable() }),
    z.object({
      kind: z.literal("runs"),
      runs: z.array(Run).max(100),
      total: z.number().int().nonnegative(),
      nextBefore: z.number().int().positive().optional(),
    }),
    z.object({
      kind: z.literal("workspaces"),
      workspaces: z
        .array(
          z.object({
            id: WorkspaceId,
            name: z.string().max(256),
            path: z.string().max(4096),
            deck: DeckOwnership.optional(),
          }),
        )
        .max(100),
      next: id.optional(),
    }),
    z.object({ kind: z.literal("error"), code: z.string().max(128) }),
  ]),
});
export type WorkspaceActionResult = z.infer<typeof WorkspaceActionResult>;
export const WorkspaceCommands = [
  z.object({
    type: z.literal("thread.workspace.set"),
    threadId: ThreadId,
    mode: z.enum(["local", "worktree"]),
    branch: z.string().min(1).max(1024).optional(),
    allowUncommitted: z.boolean().default(false),
  }),
  z.object({ type: z.literal("workspace.script.run"), threadId: ThreadId, scriptId: id }),
  z.object({ type: z.literal("workspace.editor.open"), threadId: ThreadId, editorId: id }),
  z.object({
    type: z.literal("git.commit"),
    threadId: ThreadId,
    message: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.trim().length > 0)
      .meta({ "x-ace-constraint": "Must contain a non-whitespace commit message." }),
    expectedHead: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
  }),
  z.object({
    type: z.literal("git.push"),
    threadId: ThreadId,
    remote: z.string().min(1).max(128).default("origin"),
  }),
] as const;

/** Safe command receipt codes. Git diagnostic text never crosses the wire. */
export const GitActionError = z.enum([
  "git_head_moved",
  "git_conflicts",
  "git_hook_failed",
  "git_auth_failed",
  "git_failed",
  "git_dirty_worktree",
  "git_invalid_ref",
]);
export type GitActionError = z.infer<typeof GitActionError>;
