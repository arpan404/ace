import { z } from "zod";
import { CommandId, WorkspaceId } from "./ids.ts";
import { Project, ProjectInspection } from "./projects.ts";

/*
 * Project service messages: folder browsing, inspection, clone cancellation and workspace
 * pushes. Apart from `projects.ts` so the core stream, which carries project commands and their
 * results, does not load them; only the full wire does (ADR 0056).
 */

const path = z.string().min(1).max(4096);
/** Existing folder names and cursors preserve whitespace and punctuation exactly. */
export const ProjectDirectoryName = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0"),
  )
  .meta({ "x-ace-constraint": "A literal existing directory name; no separators or NUL." });
export const ProjectsRequest = z.object({
  type: z.literal("projects.request"),
  requestId: z.string().min(1).max(128),
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("workspace.inspect"), path }),
    z.object({ op: z.literal("fs.home") }),
    z.object({
      op: z.literal("fs.recentFolders"),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    z.object({
      op: z.literal("fs.browse"),
      path,
      after: ProjectDirectoryName.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      showHidden: z.boolean().default(false),
    }),
    z.object({ op: z.literal("workspace.clone.cancel"), commandId: CommandId }),
  ]),
});
export type ProjectsRequest = z.infer<typeof ProjectsRequest>;
export const ProjectsResult = z.object({
  type: z.literal("projects.result"),
  requestId: z.string().min(1).max(128),
  result: z.discriminatedUnion("kind", [
    ProjectInspection.extend({ kind: z.literal("inspection") }),
    z.object({
      kind: z.literal("home"),
      path,
      roots: z.array(path).max(32),
      initialBranch: z.string().max(1024),
    }),
    z.object({ kind: z.literal("recentFolders"), folders: z.array(Project).max(100) }),
    z.object({
      kind: z.literal("directories"),
      path,
      entries: z
        .array(
          z.object({
            name: ProjectDirectoryName,
            path,
            git: z.boolean(),
            modifiedAt: z.number().nonnegative(),
          }),
        )
        .max(100),
      next: ProjectDirectoryName.optional(),
    }),
    z.object({ kind: z.literal("cancelled"), commandId: CommandId }),
    z.object({ kind: z.literal("error"), code: z.string().max(128) }),
  ]),
});
export type ProjectsResult = z.infer<typeof ProjectsResult>;
export const WorkspaceChanged = z.object({
  type: z.literal("workspace.changed"),
  workspaceId: WorkspaceId,
  change: z.enum(["added", "renamed", "removed"]),
  workspace: Project.optional(),
});
export type WorkspaceChanged = z.infer<typeof WorkspaceChanged>;
export const WorkspaceCloneProgress = z.object({
  type: z.literal("workspace.clone.progress"),
  commandId: CommandId,
  phase: z.enum([
    "starting",
    "receiving",
    "resolving",
    "checkout",
    "completed",
    "cancelled",
    "failed",
  ]),
  percent: z.number().int().min(0).max(100).optional(),
});
export type WorkspaceCloneProgress = z.infer<typeof WorkspaceCloneProgress>;
