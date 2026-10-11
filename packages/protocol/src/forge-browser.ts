import { ForgeMergeState } from "./forge-merge-state.ts";
import { z } from "zod";
import { ForgePrRef, ForgePrStatus, ForgeRepository } from "./forge.ts";
import { WorkspaceId, ThreadId } from "./ids.ts";

const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
export const ForgePageInput = z.object({ page: z.number().int().min(1).max(120).default(1) });
export const ForgePrSearch = z.object({
  state: z.enum(["open", "draft", "closed", "merged"]).default("open"),
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
  state: z.enum(["open", "draft", "closed", "merged"]),
  labels: z.array(text).max(100),
  updatedAt: text,
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
export const ForgeRelatedThread = z.object({ id: ThreadId, title: text, archived: z.boolean() });
export const ForgePrDetail = z.object({
  status: ForgePrStatus,
  writeState: z.enum(["pending", "uncertain"]).optional(),
  body: text,
  author: text,
  headBranch: text,
  baseBranch: text,
  baseSha: sha,
  headRepository: ForgeRepository.nullable(),
  labels: z.array(text).max(100),
  reviewers: z.array(text).max(100),
  reviewDecision: z.string().max(100).nullable(),
  commits: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  relatedThreads: z.array(ForgeRelatedThread).max(100),
  relatedThreadsTruncated: z.boolean(),
});
export type ForgePrDetail = z.infer<typeof ForgePrDetail>;
export const ForgeCommit = z.object({
  raw: z.unknown().optional(),
  sha,
  message: text,
  author: text,
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
  at: text.nullable(),
  raw: z.unknown(),
});
const scope = { workspaceId: WorkspaceId, repository: ForgeRepository.optional() };
export const ForgeBrowserOperations = [
  z.object({
    op: z.literal("forge.pr.merge-state"),
    ...scope,
    number: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("forge.pr.activity"),
    ...scope,
    number: z.number().int().positive(),
    ...ForgePageInput.shape,
  }),
  z.object({ op: z.literal("forge.pr.list"), ...scope, query: ForgePrSearch }),
  z.object({ op: z.literal("forge.pr.detail"), ...scope, number: z.number().int().positive() }),
  z.object({
    op: z.literal("forge.pr.commits"),
    ...scope,
    number: z.number().int().positive(),
    ...ForgePageInput.shape,
    headSha: sha,
  }),
  z.object({
    op: z.literal("forge.pr.files"),
    ...scope,
    number: z.number().int().positive(),
    ...ForgePageInput.shape,
    headSha: sha,
    baseSha: sha,
    commit: sha.optional(),
  }),
] as const;
export const ForgeBrowserResult = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("prMergeState"), value: ForgeMergeState }),
  z.object({
    resource: z.literal("prActivity"),
    events: z.array(ForgeActivity).max(25),
    nextPage: z.number().int().positive().optional(),
    truncated: z.boolean(),
  }),
  z.object({ resource: z.literal("prList"), value: ForgePrList }),
  z.object({ resource: z.literal("prDetail"), value: ForgePrDetail }),
  z.object({
    resource: z.literal("prCommits"),
    commits: z.array(ForgeCommit).max(25),
    nextPage: z.number().int().positive().optional(),
    truncated: z.boolean(),
  }),
  z.object({ resource: z.literal("prFiles"), value: ForgePrFiles }),
]);
export type ForgeBrowserResult = z.infer<typeof ForgeBrowserResult>;
export type ForgeBrowserOperation = z.infer<(typeof ForgeBrowserOperations)[number]>;
