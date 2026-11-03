import { SourceControlContext } from "./source-control-draft.ts";
import { ForgeMergeCommit, ForgeMergeState } from "./forge-merge-state.ts";
import { ForgeStackExpected } from "./forge-stacks.ts";
import { z } from "zod";

/** The longest pull request description or comment, GitHub's own body limit. */
export const maxForgeTextLength = 65_536;
const text = z.string().max(maxForgeTextLength);
export const ForgeRepository = z.object({
  forge: z.enum(["github", "gitlab"]),
  host: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .max(253),
  owner: z
    .string()
    .regex(/^[\w.-]+(?:\/[\w.-]+)*$/)
    .max(512)
    .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."))
    .meta({
      "x-ace-constraint": "Every owner path segment must differ from . and ..",
      not: { pattern: "(?:^|/)\\.{1,2}(?:/|$)" },
    }),
  name: z
    .string()
    .regex(/^[\w.-]+$/)
    .max(100),
});
export type ForgeRepository = z.infer<typeof ForgeRepository>;
export const ForgePrRef = z.object({
  repository: ForgeRepository,
  number: z.number().int().positive(),
});
export type ForgePrRef = z.infer<typeof ForgePrRef>;
/** Local association, including a last known state when GitHub is unreachable. */
export const LinkedPullRequest = z.object({
  number: z.number().int().positive(),
  repo: ForgeRepository,
  url: z.url().max(4096),
  state: z.enum(["open", "draft", "merged", "closed"]),
  title: z.string().max(65_536).optional(),
  updatedAt: z.number().int().nonnegative(),
  /** The head commit the forge last reported. */
  head: z.string().max(64).optional(),
  /** The head commit's checks, rolled up: still running, all passed, or any failed. */
  checks: z.enum(["pending", "passed", "failed"]).optional(),
  unverified: z.boolean().optional(),
  deleted: z.boolean().optional(),
});
export type LinkedPullRequest = z.infer<typeof LinkedPullRequest>;
export const ForgeCheck = z.object({
  id: z.string().max(256),
  name: text,
  status: z.enum(["pending", "success", "failure", "cancelled", "unknown"]),
  conclusion: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** When the check started running; absent from older reads and from commit statuses. */
  startedAt: z.string().nullable().optional(),
  jobId: z.number().int().positive().nullable(),
  url: text.nullable(),
});
export type ForgeCheck = z.infer<typeof ForgeCheck>;
export const ForgeComment = z.object({
  kind: z.enum(["inline", "issue", "review"]),
  id: z.number().int().positive(),
  body: text,
  author: text,
  authorAvatarUrl: text.optional(),
  file: text.nullable(),
  line: z.number().int().nullable(),
  updatedAt: z.string(),
  createdAt: z.string().optional(),
  replyTo: z.number().int().nullable(),
  reviewState: z.string().max(256).optional(),
});
export type ForgeComment = z.infer<typeof ForgeComment>;
export const ForgeReviewThread = z.object({
  id: z.string(),
  resolved: z.boolean(),
  outdated: z.boolean(),
  file: text,
  line: z.number().int().nullable(),
  /** Which side of the diff `line` (and `startLine`) count on; absent from older reads. */
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  /** The first line of a multi-line thread; null or absent for a single line. */
  startLine: z.number().int().nullable().optional(),
  /** The side `startLine` counts on, when the thread starts on the other side from `side`. */
  startSide: z.enum(["LEFT", "RIGHT"]).optional(),
  /**
   * GitHub's diff hunk for the thread's first comment: the code it was written on, ending at
   * the commented line, trimmed to its last lines. Absent when GitHub sent none.
   */
  hunk: z.string().max(20_000).optional(),
  /** The line (and first line) the thread was written on, in `originalCommit`. */
  originalLine: z.number().int().nullable().optional(),
  originalStartLine: z.number().int().nullable().optional(),
  /** The commit the thread was written on; differs from the head once outdated. */
  originalCommit: z.string().max(64).optional(),
  comments: z.array(ForgeComment).max(2_000),
});
export const ForgePrStatus = z.object({
  ref: ForgePrRef,
  title: text,
  url: text,
  headSha: z.string().max(256),
  state: z.enum(["open", "draft", "closed", "merged", "unknown"]),
  mergeability: z.enum(["mergeable", "conflicting", "unknown"]),
  ci: z.enum(["none", "pending", "success", "failure", "unknown"]),
  checks: z.array(ForgeCheck).max(2_000),
  comments: z.array(ForgeComment).max(2_000),
  reviewThreads: z.array(ForgeReviewThread).max(2_000),
  mergeState: ForgeMergeState.optional(),
  raw: z.unknown(),
});
export type ForgePrStatus = z.infer<typeof ForgePrStatus>;
export const ForgeThreadLink = z.object({ threadId: z.string().min(1).max(256), pr: ForgePrRef });
export type ForgeThreadLink = z.infer<typeof ForgeThreadLink>;
export const ForgeLinkState = z.object({
  link: ForgeThreadLink,
  generation: z.number().int().positive(),
});
export type ForgeLinkState = z.infer<typeof ForgeLinkState>;
export const ForgeAutoFixIntent = z.object({
  type: z.literal("auto-fix"),
  key: z.string().max(1_024),
  link: ForgeThreadLink,
  linkGeneration: z.number().int().positive().default(1),
  headSha: z.string().max(256),
  context: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ci"),
      check: ForgeCheck,
      logTail: text,
      truncated: z.boolean(),
      logUnavailable: z.boolean(),
    }),
    z.object({ type: z.literal("review"), comment: ForgeComment }),
  ]),
});
export type ForgeAutoFixIntent = z.infer<typeof ForgeAutoFixIntent>;
export const ForgeCreatePrInput = z.object({
  expectedHead: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  branch: z.string().min(1).max(256),
  /**
   * `forge.pr.create` honours this only with a `draftFingerprint`, whose reviewed summary was
   * made against it. Otherwise the daemon resolves the base: the thread's recorded base branch,
   * else the forge repository's default branch (the parent's, for a fork). Package callers of
   * `createPr` must supply it.
   */
  base: z.string().min(1).max(256).optional(),
  title: z.string().min(1).max(256),
  summary: text,
  template: z.object({ title: z.string().min(1).max(256), body: text }),
  draft: z.boolean().default(false),
});
export type ForgeCreatePrInput = z.infer<typeof ForgeCreatePrInput>;
export const ForgeCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("forge.pr.merge-state.change"),
    link: ForgeThreadLink,
    headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
    action: z.enum(["enable", "disable", "dequeue"]),
    method: z.enum(["merge", "squash", "rebase"]),
    /** The commit auto-merge writes; only with `enable` and a merge or squash. */
    commit: ForgeMergeCommit.optional(),
  }),
  z.object({
    type: z.literal("forge.pr.stack.change"),
    link: ForgeThreadLink,
    expected: ForgeStackExpected,
    action: z.enum(["merge", "rebase", "continue", "abort", "push", "sync"]),
    method: z.enum(["merge", "squash", "rebase"]),
  }),
  z.object({ type: z.literal("forge.pr.status"), link: ForgeThreadLink }),
  z.object({
    type: z.literal("forge.pr.create"),
    threadId: z.string(),
    repository: ForgeRepository,
    input: ForgeCreatePrInput,
    draftFingerprint: SourceControlContext.shape.fingerprint.optional(),
    draftBaseRef: z.string().min(1).max(1200).optional(),
  }),
  z.object({ type: z.literal("forge.pr.link"), link: ForgeThreadLink }),
  z
    .object({
      type: z.literal("forge.pr.unlink"),
      threadId: z.string(),
      number: z.number().int().positive().optional(),
      repo: ForgeRepository.optional(),
      all: z.literal(true).optional(),
    })
    .refine((value) => (value.number !== undefined) !== (value.all === true), {
      message: "Choose a pull request number or all",
    })
    .meta({
      "x-ace-constraint": "Exactly one of number or all is required",
      oneOf: [{ required: ["number"] }, { required: ["all"] }],
    }),
  z.object({
    type: z.literal("forge.comment.reply"),
    link: ForgeThreadLink,
    commentId: z.number().int().positive(),
    body: text,
  }),
  z.object({
    type: z.literal("forge.review.request"),
    link: ForgeThreadLink,
    reviewers: z
      .array(z.string().regex(/^[\w-]+$/))
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal("forge.pr.merge"),
    link: ForgeThreadLink,
    headSha: z.string(),
    method: z.enum(["merge", "squash", "rebase"]),
    /** The merge or squash commit's title and message; GitHub's own when absent. */
    commit: ForgeMergeCommit.optional(),
  }),
  z.object({
    type: z.literal("forge.pr.auto-merge"),
    link: ForgeThreadLink,
    headSha: z.string(),
    method: z.enum(["merge", "squash", "rebase"]),
  }),
]);
export const ForgeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forge.pr.linked"), link: ForgeThreadLink }),
  z.object({ type: z.literal("forge.pr.updated"), link: ForgeThreadLink, status: ForgePrStatus }),
  z.object({ type: z.literal("forge.auto-fix.queued"), intent: ForgeAutoFixIntent }),
]);
