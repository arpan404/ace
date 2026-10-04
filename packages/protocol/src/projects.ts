import { z } from "zod";
import { CommandId, WorkspaceId } from "./ids.ts";

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
/** Shared validation, also used before client outbox persistence. Test transports inject at Git's boundary. */
export const ProjectCloneUrl = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/)
  .refine((value) => {
    if ([...value].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127))
      return false;
    if (value.startsWith("git@")) return /^git@[^/:]+:[^:]+$/.test(value);
    try {
      const url = new URL(value);
      return (
        Boolean(url.hostname) &&
        !url.password &&
        (url.protocol === "ssh:" || (url.protocol === "https:" && !url.username))
      );
    } catch {
      return false;
    }
  })
  .meta({
    "x-ace-constraint":
      "HTTPS, SSH or scp-style git@ URL with a host; no passwords, HTTPS usernames, whitespace or control bytes.",
    examples: [
      "https://example.invalid/repo.git",
      "ssh://git@example.invalid/repo.git",
      "git@example.invalid:repo.git",
    ],
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
export const ProjectCommand = z.discriminatedUnion("type", ProjectCommands);
export type ProjectCommand = z.infer<typeof ProjectCommand>;
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
