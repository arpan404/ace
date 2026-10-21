import { ForgeLifecycleState } from "./forge-lifecycle.ts";
import { ForgeIssueOperations, ForgeIssueResults, ForgeIssueRow } from "./forge-issues.ts";
import { ForgeMergeState } from "./forge-merge-state.ts";
import { ForgeStackMembership, ForgeStackWorkspace } from "./forge-stacks.ts";
import { ForgeReviewState } from "./forge-review.ts";
import { ForgeCheckOperations, ForgeCheckResults } from "./forge-checks.ts";
import { ForgeFileContentOperations, ForgeFileContentResults } from "./forge-file-content.ts";
import { z } from "zod";
import { ForgePrRef, ForgePrStatus, ForgeRepository } from "./forge.ts";
import { WorkspaceId, ThreadId } from "./ids.ts";

const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
export const ForgePageInput = z.object({ page: z.number().int().min(1).max(120).default(1) });
/** A timeline page of up to 100 events; a long pull request has many. */
export const ForgeActivityPageInput = z.object({
  page: z.number().int().min(1).max(10_000).default(1),
});
/** A provider's opaque position in a newest-first list. */
const cursor = z.string().min(1).max(256);
/**
 * A page of a PR's changed files. GitHub lists the first 3,000 in 120 pages; later pages come
 * from comparing the two trees, up to 100,000 files.
 */
export const ForgeFilePageInput = z.object({
  page: z.number().int().min(1).max(4_000).default(1),
});
export const ForgePrSearch = z.object({
  /** `open` leaves drafts out; `active` is every open PR, drafts included. */
  state: z.enum(["open", "draft", "closed", "merged", "active"]).default("open"),
  /** `failure`: only PRs whose head commit's checks failed. */
  ci: z.enum(["any", "failure"]).default("any"),
  search: z.string().max(256).default(""),
  author: z
    .string()
    .regex(/^[\w-]*$/)
    .max(100)
    .default(""),
  reviewer: z
    .string()
    .regex(/^[\w-]*$/)
    .max(100)
    .default(""),
  sort: z.enum(["created", "updated", "comments"]).default("updated"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).max(40).default(1),
});
export type ForgePrSearch = z.infer<typeof ForgePrSearch>;
export const ForgePrRow = z.object({
  raw: z.unknown().optional(),
  ref: ForgePrRef,
  title: text,
  url: text,
  author: text,
  authorAvatarUrl: text.optional(),
  state: z.enum(["open", "draft", "closed", "merged"]),
  labels: z.array(text).max(100),
  updatedAt: text,
  commentCount: z.number().int().nonnegative().optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  ci: ForgePrStatus.shape.ci.optional(),
});
export type ForgePrRow = z.infer<typeof ForgePrRow>;
export const ForgePrList = z.object({
  repository: ForgeRepository,
  items: z.array(ForgePrRow).max(25),
  total: z.number().int().nonnegative(),
  nextPage: z.number().int().positive().optional(),
  counts: z.object({
    open: z.number().int().nonnegative(),
    draft: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
  }),
  incomplete: z.boolean(),
  truncated: z.boolean(),
});
export type ForgePrList = z.infer<typeof ForgePrList>;
/**
 * What New thread lists under its composer, read in one request: the first 25 open pull requests
 * (drafts included) and open issues, newest activity first, the open pull requests whose checks
 * failed however old, and how many of each there are.
 */
export const ForgeOpenWork = z.object({
  repository: ForgeRepository,
  pullRequests: z.object({
    items: z.array(ForgePrRow).max(25),
    total: z.number().int().nonnegative(),
  }),
  failingPullRequests: z.object({
    items: z.array(ForgePrRow).max(25),
    total: z.number().int().nonnegative(),
  }),
  issues: z.object({
    items: z.array(ForgeIssueRow).max(25),
    total: z.number().int().nonnegative(),
  }),
});
export type ForgeOpenWork = z.infer<typeof ForgeOpenWork>;
export const ForgeRelatedThread = z.object({ id: ThreadId, title: text, archived: z.boolean() });
export const ForgePrDetailFile = z.object({
  path: text,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  status: text,
});
export type ForgePrDetailFile = z.infer<typeof ForgePrDetailFile>;
export const ForgePrDetail = z.object({
  status: ForgePrStatus,
  writeState: z.enum(["pending", "uncertain"]).optional(),
  updatedAt: text.optional(),
  createdAt: text.optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  reviewerAvatars: z.record(z.string(), text).optional(),
  body: text,
  author: text,
  authorAvatarUrl: text.optional(),
  headBranch: text,
  baseBranch: text,
  baseSha: sha,
  headRepository: ForgeRepository.nullable(),
  labels: z.array(text).max(100),
  reviewers: z.array(text).max(100),
  reviewDecision: z.string().max(100).nullable(),
  commits: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  files: z.array(ForgePrDetailFile).max(100).optional(),
  relatedThreads: z.array(ForgeRelatedThread).max(100),
  relatedThreadsTruncated: z.boolean(),
});
export type ForgePrDetail = z.infer<typeof ForgePrDetail>;
export const ForgeCommit = z.object({
  raw: z.unknown().optional(),
  sha,
  message: text,
  author: text,
  authorAvatarUrl: text.optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  date: text.nullable(),
  url: text,
});
export type ForgeCommit = z.infer<typeof ForgeCommit>;
export const ForgeFile = z.object({
  raw: z.unknown().optional(),
  path: text,
  previousPath: text.optional(),
  status: text,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(262_144).nullable(),
  truncated: z.boolean(),
});
export type ForgeFile = z.infer<typeof ForgeFile>;
export const ForgePrFiles = z.object({
  ref: ForgePrRef,
  baseSha: sha,
  headSha: sha,
  commit: sha.optional(),
  files: z.array(ForgeFile).max(25),
  nextPage: z.number().int().positive().optional(),
  truncated: z.boolean(),
});
export type ForgePrFiles = z.infer<typeof ForgePrFiles>;
export const ForgeActivity = z.object({
  id: z.string().max(256),
  event: text,
  actor: text,
  actorAvatarUrl: text.optional(),
  subject: text.optional(),
  commitSha: sha.optional(),
  at: text.nullable(),
  raw: z.unknown(),
});
export type ForgeActivity = z.infer<typeof ForgeActivity>;
const scope = { workspaceId: WorkspaceId, repository: ForgeRepository.optional() };
export const ForgeBrowserOperations = [
  z.object({ op: z.literal("forge.pr.lifecycle"), ...scope, number: z.number().int().positive() }),
  ...ForgeIssueOperations,
  ...ForgeFileContentOperations,
  z.object({
    op: z.literal("forge.pr.merge-state"),
    ...scope,
    number: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("forge.pr.stack"),
    ...scope,
    threadId: ThreadId.optional(),
    number: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("forge.pr.stack-memberships"),
    ...scope,
    numbers: z.array(z.number().int().positive()).max(100),
  }),
  z.object({
    op: z.literal("forge.pr.review-state"),
    ...scope,
    number: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("forge.pr.activity"),
    ...scope,
    number: z.number().int().positive(),
    ...ForgeActivityPageInput.shape,
  }),
  z.object({ op: z.literal("forge.pr.list"), ...scope, query: ForgePrSearch }),
  z.object({ op: z.literal("forge.open-work"), ...scope }),
  z.object({ op: z.literal("forge.pr.detail"), ...scope, number: z.number().int().positive() }),
  z.object({
    op: z.literal("forge.pr.commits"),
    ...scope,
    number: z.number().int().positive(),
    /** The page older than this cursor; none reads the newest page. */
    before: cursor.optional(),
    headSha: sha,
  }),
  z.object({
    op: z.literal("forge.pr.files"),
    ...scope,
    number: z.number().int().positive(),
    ...ForgeFilePageInput.shape,
    headSha: sha,
    baseSha: sha,
    commit: sha.optional(),
  }),
  ...ForgeCheckOperations,
] as const;
export const ForgeBrowserResult = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("prLifecycle"), value: ForgeLifecycleState }),
  ...ForgeIssueResults,
  ...ForgeFileContentResults,
  z.object({ resource: z.literal("prMergeState"), value: ForgeMergeState }),
  z.object({ resource: z.literal("prStack"), value: ForgeStackWorkspace }),
  z.object({
    resource: z.literal("prStackMemberships"),
    value: z.array(ForgeStackMembership).max(100),
  }),
  z.object({ resource: z.literal("prReviewState"), value: ForgeReviewState }),
  z.object({
    resource: z.literal("prActivity"),
    events: z.array(ForgeActivity).max(100),
    nextPage: z.number().int().positive().optional(),
    /** The timeline's last (newest) page, so the pages between can be read at once. */
    lastPage: z.number().int().positive().optional(),
    truncated: z.boolean(),
  }),
  z.object({ resource: z.literal("prList"), value: ForgePrList }),
  z.object({ resource: z.literal("openWork"), value: ForgeOpenWork }),
  z.object({ resource: z.literal("prDetail"), value: ForgePrDetail }),
  z.object({
    resource: z.literal("prCommits"),
    /** One page, oldest first; pages come newest first. */
    commits: z.array(ForgeCommit).max(100),
    /** Pass as `before` to read the next older page; absent on the oldest page. */
    before: cursor.optional(),
    /**
     * Pages older than every page `before` leads to, newest first, each read on its own (as
     * `before`), so side by side. Only the newest page names them.
     */
    alongside: z.array(cursor).max(1_000).optional(),
    /** How many commits the pull request has. */
    total: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
  }),
  z.object({ resource: z.literal("prFiles"), value: ForgePrFiles }),
  ...ForgeCheckResults,
]);
export type ForgeBrowserResult = z.infer<typeof ForgeBrowserResult>;
export type ForgeBrowserOperation = z.infer<(typeof ForgeBrowserOperations)[number]>;
