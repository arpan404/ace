import { z } from "zod";
import { ForgeCommit, ForgeFile } from "./forge-changes.ts";
import { ForgeLabelColor } from "./forge-issues.ts";
import { ForgeRepository } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const branch = z.string().min(1).max(256);
const login = z
  .string()
  .regex(/^[\w-]+$/)
  .max(100);
const scope = { workspaceId: WorkspaceId, repository: ForgeRepository.optional() };

/** A branch on GitHub and the commit it points at. */
export const ForgeBranch = z.object({ name: branch, sha });
export type ForgeBranch = z.infer<typeof ForgeBranch>;

/**
 * Where a new pull request of a project can open: the repository it opens on (a fork's parent)
 * and its branches to merge into, and the repository whose branches it can come from.
 */
export const ForgeNewPrContext = z.object({
  base: z.object({
    repository: ForgeRepository,
    defaultBranch: branch,
    branches: z.array(ForgeBranch).max(1_000),
    truncated: z.boolean(),
  }),
  head: z.object({
    repository: ForgeRepository,
    branches: z.array(ForgeBranch).max(1_000),
    truncated: z.boolean(),
  }),
  /** The repository's pull request template, when it has one. */
  template: text.nullable(),
});
export type ForgeNewPrContext = z.infer<typeof ForgeNewPrContext>;

export const ForgeMilestone = z.object({
  number: z.number().int().positive(),
  title: text,
  state: z.enum(["open", "closed"]),
  dueOn: text.nullable(),
});
export type ForgeMilestone = z.infer<typeof ForgeMilestone>;

/** What a pull request of the repository may be given: labels, people and open milestones. */
export const ForgeRepoPrOptions = z.object({
  labels: z
    .array(z.object({ name: text, color: ForgeLabelColor.optional(), description: text }))
    .max(500),
  /** People GitHub lets be assigned; the same people can be asked to review. */
  assignable: z.array(z.object({ login, avatarUrl: text.optional() })).max(500),
  milestones: z.array(ForgeMilestone).max(100),
  truncated: z.boolean(),
});
export type ForgeRepoPrOptions = z.infer<typeof ForgeRepoPrOptions>;

/** The head side of a comparison: a branch of the base repository, or of a fork of it. */
export const ForgeCompareHead = z.object({ owner: login, branch });
export type ForgeCompareHead = z.infer<typeof ForgeCompareHead>;

/** Commits and changed files between two branches, as a pull request of them would show. */
export const ForgeCompare = z.object({
  base: branch,
  head: ForgeCompareHead,
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
  aheadBy: z.number().int().nonnegative(),
  behindBy: z.number().int().nonnegative(),
  mergeBaseSha: sha,
  headSha: sha,
  /** Oldest first. GitHub lists at most 250. */
  commits: z.array(ForgeCommit).max(250),
  totalCommits: z.number().int().nonnegative(),
  /** One page of changed files. */
  files: z.array(ForgeFile).max(25),
  totalFiles: z.number().int().nonnegative(),
  nextPage: z.number().int().positive().optional(),
  /** GitHub left commits or files out: the pull request will show them all. */
  truncated: z.boolean(),
});
export type ForgeCompare = z.infer<typeof ForgeCompare>;

export const ForgeNewPrOperations = [
  z.object({ op: z.literal("forge.pr.new-context"), workspaceId: WorkspaceId }),
  z.object({ op: z.literal("forge.repo.pr-options"), ...scope }),
  z.object({
    op: z.literal("forge.compare"),
    ...scope,
    base: branch,
    head: ForgeCompareHead,
    page: z.number().int().min(1).max(12).default(1),
  }),
] as const;
export const ForgeNewPrResults = [
  z.object({ resource: z.literal("newPrContext"), value: ForgeNewPrContext }),
  z.object({ resource: z.literal("repoPrOptions"), value: ForgeRepoPrOptions }),
  z.object({ resource: z.literal("compare"), value: ForgeCompare }),
] as const;

/**
 * Open a pull request of a project from any branch, without a thread. The daemon opens it on
 * the repository `forge.pr.new-context` named (a fork's parent) and links nothing. An open PR
 * of the same head and base is returned instead (`prExisting`), so a create whose answer was
 * lost is never sent twice. Reviewers, labels, assignees and the milestone follow the create;
 * when GitHub refuses them the PR stays open and the result's `code` says so.
 */
export const ForgeHostedPrCreateCommand = z.object({
  type: z.literal("forge.hosted.pr.create"),
  workspaceId: WorkspaceId,
  /** The repository it opens on, as the context read named it. */
  repository: ForgeRepository,
  base: branch,
  head: ForgeCompareHead,
  title: z.string().min(1).max(256).regex(/\S/),
  body: text,
  draft: z.boolean().default(false),
  reviewers: z.array(login).max(100).default([]),
  labels: z.array(z.string().min(1).max(256)).max(100).default([]),
  assignees: z.array(login).max(10).default([]),
  milestone: z.number().int().positive().optional(),
});
export type ForgeHostedPrCreateCommand = z.infer<typeof ForgeHostedPrCreateCommand>;
