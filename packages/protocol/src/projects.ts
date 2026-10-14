import { RepositoryPublishInput } from "./hosted-repositories.ts";
import { z } from "zod";
import { WorkspaceId } from "./ids.ts";
import { BadgeColor } from "./badge-color.ts";
import { ProviderKind } from "./provider-data.ts";
import { AccessMode } from "./permissions.ts";
import { ProjectNote, ProjectNoteEdit, maxProjectNotes } from "./project-notes.ts";

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
const iconUrl = z.url();
/** Small raster uploads or explicitly selected remote icons. SVG and executable schemes are excluded. */
export const ProjectIcon = z.union([
  z
    .string()
    .max(4096)
    .regex(/^(?![\s\S]*[\t\r\n])[hH][tT][tT][pP][sS]?:\/\/[\s\S]*[^\s]$/)
    .refine((value) => iconUrl.safeParse(value).success)
    .meta({
      format: "ace-whatwg-url",
      "x-ace-url-maxLength": 4096,
      "x-ace-constraint":
        "Absolute HTTP or HTTPS WHATWG URL, without ASCII tabs, CR, LF or trailing whitespace; at most 4096 UTF-16 code units. Install the ace-whatwg-url format validator or enforce URL parsing in application code.",
      examples: ["https://example.invalid/icon.png", "HTTPS://例え.テスト/icon.png"],
    }),
  z
    .string()
    .max(131072)
    .regex(
      /^data:image\/(?:png|jpeg|gif|webp|x-icon);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/,
    ),
]);
/** The curated marks a project badge can show in place of its initials. */
export const ProjectGlyph = z.enum([
  "code",
  "terminal",
  "globe",
  "database",
  "cloud",
  "robot",
  "rocket",
  "flask",
  "book",
  "cube",
  "game",
  "mobile",
  "palette",
  "gear",
  "lightning",
  "leaf",
  "star",
  "heart",
]);
export type ProjectGlyph = z.infer<typeof ProjectGlyph>;
/**
 * A badge the person chose: the project's initials, or a curated glyph, in a curated colour.
 * Without a colour the badge keeps the tint derived from the project id. A custom `icon` image
 * still wins over it; without either, the detected favicon and then the initials show.
 */
export const ProjectBadgeStyle = z.object({
  color: BadgeColor.optional(),
  glyph: ProjectGlyph.optional(),
});
export type ProjectBadgeStyle = z.infer<typeof ProjectBadgeStyle>;
/** What new threads in the project start with; each omitted field inherits the global setting. */
export const ProjectDefaults = z
  .object({
    provider: ProviderKind.optional(),
    /** The provider's model id; needs `provider`. */
    model: z.string().min(1).max(256).optional(),
    worktree: z.boolean().optional(),
    /** Access for new threads in the project, ahead of the daemon's default. */
    access: AccessMode.optional(),
    baseBranch: z.string().min(1).max(1024).optional(),
  })
  .refine((value) => value.model === undefined || value.provider !== undefined, {
    message: "A default model needs its provider",
  })
  .meta({ "x-ace-constraint": "`model` is present only together with `provider`." });
export type ProjectDefaults = z.infer<typeof ProjectDefaults>;
export const Project = z.object({
  id: WorkspaceId,
  name: z.string().max(256),
  path,
  icon: ProjectIcon.nullable().optional(),
  defaultIcon: ProjectIcon.nullable().optional(),
  badge: ProjectBadgeStyle.optional(),
  defaults: ProjectDefaults.optional(),
  notes: z.array(ProjectNote).max(maxProjectNotes).optional(),
});
export type Project = z.infer<typeof Project>;
export const ProjectInspection = z.object({
  path,
  defaultIcon: ProjectIcon.nullable().optional(),
  git: ProjectGit.nullable(),
  /** Registration can succeed while uncertain Git cleanup still fences execution. */
  gitUnavailable: z.literal("git_quarantined").optional(),
  suggestedRepoRoot: path.optional(),
});
export const ProjectCommands = [
  z.object({
    type: z.literal("workspace.publish"),
    workspaceId: WorkspaceId,
    input: RepositoryPublishInput,
  }),
  z.object({
    type: z.literal("workspace.add"),
    path,
    name: ProjectName.optional(),
    icon: ProjectIcon.nullable().optional(),
    /**
     * Create the folder and any missing parents first (`mkdir -p`); a folder already there is
     * just added. Folders it made are removed again when registration fails.
     */
    create: z.literal(true).optional(),
  }),
  /**
   * Allow a folder as a project root (`projects.roots`), keeping home allowed when it is the
   * first. With `create`, a missing folder and its missing parents are made first; without it
   * a missing folder is refused with `directory_missing`.
   */
  z.object({
    type: z.literal("workspace.root.add"),
    path,
    create: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("workspace.create"),
    parent: path,
    name: ProjectName,
    icon: ProjectIcon.nullable().optional(),
    git: z.object({ initialBranch: z.string().min(1).max(1024).optional() }).optional(),
    gitignore: z.string().max(65536).optional(),
  }),
  z.object({
    type: z.literal("workspace.clone"),
    parent: path,
    name: ProjectName,
    icon: ProjectIcon.nullable().optional(),
    url: z.string().min(1).max(4096),
  }),
  z.object({
    type: z.literal("workspace.update"),
    workspaceId: WorkspaceId,
    name: ProjectName,
    /** A custom image; null clears it. Omitted keeps the saved one. */
    icon: ProjectIcon.nullable().optional(),
    /** The chosen badge; null returns to the detected favicon or initials. */
    badge: ProjectBadgeStyle.nullable().optional(),
    /** Replaces the project's new-thread defaults; null inherits every global setting. */
    defaults: ProjectDefaults.nullable().optional(),
    /** Replaces the project's notes, in order. Omitted keeps them. */
    notes: z.array(ProjectNoteEdit).max(maxProjectNotes).optional(),
  }),
  z.object({ type: z.literal("workspace.rename"), workspaceId: WorkspaceId, name: ProjectName }),
  z.object({
    type: z.literal("workspace.remove"),
    workspaceId: WorkspaceId,
    archiveThreads: z.boolean().default(false),
  }),
] as const;
