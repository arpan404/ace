import { z } from "zod";

const text = z.string().max(65_536);
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
export const ForgeCheck = z.object({
  id: z.string().max(256),
  name: text,
  status: z.enum(["pending", "success", "failure", "cancelled", "unknown"]),
  conclusion: z.string().nullable(),
  completedAt: z.string().nullable(),
  jobId: z.number().int().positive().nullable(),
  url: text.nullable(),
});
export type ForgeCheck = z.infer<typeof ForgeCheck>;
export const ForgeComment = z.object({
  kind: z.enum(["inline", "issue", "review"]),
  id: z.number().int().positive(),
  body: text,
  author: text,
  file: text.nullable(),
  line: z.number().int().nullable(),
  updatedAt: z.string(),
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
  branch: z.string().min(1).max(256),
  base: z.string().min(1).max(256),
  title: z.string().min(1).max(256),
  summary: text,
  template: z.object({ title: z.string().min(1).max(256), body: text }),
  draft: z.boolean().default(false),
});
export type ForgeCreatePrInput = z.infer<typeof ForgeCreatePrInput>;
export const ForgeCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forge.pr.status"), link: ForgeThreadLink }),
  z.object({
    type: z.literal("forge.pr.create"),
    threadId: z.string(),
    repository: ForgeRepository,
    input: ForgeCreatePrInput,
  }),
  z.object({ type: z.literal("forge.pr.link"), link: ForgeThreadLink }),
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
