import { z } from "zod";
import { WorkspaceId } from "./ids.ts";

/*
 * Projects as the core stream carries them: the project commands and the workspace and
 * inspection a command result returns. The project service messages live in
 * `project-requests.ts`, which only the full wire loads (ADR 0056).
 */

const path = z.string().min(1).max(4096);
export const ProjectName = z
  .string()
  .min(1)
  .max(256)
  // oxlint-disable-next-line no-control-regex -- Folder names reject control bytes.
  .regex(/^[^/\\\x00-\x1f]+$/)
  .refine(
    (value) => value === value.trim() && value !== "." && value !== ".." && !value.endsWith("."),
  )
  .meta({
    "x-ace-constraint": "One folder name, without separators, traversal or control characters.",
  });
export const ProjectGit = z.object({
  root: path,
  branch: z.string().max(1024).nullable(),
  defaultBranch: z.string().max(1024),
  remotes: z
    .array(
      z.object({
        name: z.string().max(256),
        fetchUrls: z.array(path).max(32),
        pushUrls: z.array(path).max(32),
      }),
    )
    .max(64),
});
export const Project = z.object({ id: WorkspaceId, name: z.string().max(256), path });
export type Project = z.infer<typeof Project>;
export const ProjectInspection = z.object({
  path,
  git: ProjectGit.nullable(),
  suggestedRepoRoot: path.optional(),
});
export const ProjectCommands = [
  z.object({ type: z.literal("workspace.add"), path, name: ProjectName.optional() }),
  z.object({
    type: z.literal("workspace.create"),
    parent: path,
    name: ProjectName,
    git: z.object({ initialBranch: z.string().min(1).max(1024).optional() }).optional(),
    gitignore: z.string().max(65536).optional(),
  }),
  z.object({
    type: z.literal("workspace.clone"),
    parent: path,
    name: ProjectName,
    url: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal("workspace.rename"), workspaceId: WorkspaceId, name: ProjectName }),
  z.object({
    type: z.literal("workspace.remove"),
    workspaceId: WorkspaceId,
    archiveThreads: z.boolean().default(false),
  }),
] as const;
