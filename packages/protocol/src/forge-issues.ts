import { z } from "zod";
import { ForgeRepository } from "./forge.ts";
import { CommandId, ThreadId, WorkspaceId } from "./ids.ts";

const text = z.string().max(65_536);
/** A search filter's login, or `@me`, which GitHub resolves to the account `gh` signed in as. */
export const ForgeSearchLogin = z
  .string()
  .regex(/^(@me|[\w-]*)$/)
  .max(100)
  .default("");
const login = ForgeSearchLogin;
/** A label's colour as GitHub keeps it: six hex digits without `#`. */
export const ForgeLabelColor = z.string().regex(/^[0-9a-fA-F]{6}$/);
/** The colour of each label a row names, by label name; a label with none is missing. */
export const ForgeLabelColors = z.record(z.string().max(256), ForgeLabelColor);
/** Avatars by login, as GitHub links them; the client loads them through the daemon. */
export const ForgeAvatars = z.record(z.string().max(100), text);
export const ForgeIssueRef = z.object({
  repository: ForgeRepository,
  number: z.number().int().positive(),
});
export type ForgeIssueRef = z.infer<typeof ForgeIssueRef>;
export const ForgeIssueSearch = z.object({
  state: z.enum(["open", "closed"]).default("open"),
  search: z.string().max(256).default(""),
  author: login,
  assignee: login,
  labels: z.array(z.string().min(1).max(100)).max(20).default([]),
  milestone: z.string().max(100).default(""),
  sort: z.enum(["created", "updated", "comments"]).default("updated"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).max(40).default(1),
});
export type ForgeIssueSearch = z.infer<typeof ForgeIssueSearch>;
export const ForgeIssueRow = z.object({
  ref: ForgeIssueRef,
  title: text,
  url: text,
  author: text,
  state: z.enum(["open", "closed"]),
  labels: z.array(text).max(100),
  assignees: z.array(text).max(100),
  milestone: text.nullable(),
  createdAt: text,
  updatedAt: text,
  authorAvatarUrl: text.optional(),
  labelColors: ForgeLabelColors.optional(),
  commentCount: z.number().int().nonnegative().optional(),
  /** The author's and assignees' avatars. */
  avatars: ForgeAvatars.optional(),
  raw: z.unknown().optional(),
});
export type ForgeIssueRow = z.infer<typeof ForgeIssueRow>;
export const ForgeIssueDetail = ForgeIssueRow.extend({
  body: text,
  /** Whether the host restricts this issue to authorized participants. */
  confidential: z.boolean().optional(),
  permissions: z.object({
    edit: z.boolean(),
    close: z.boolean(),
    reopen: z.boolean(),
    comment: z.boolean(),
    /** Labels, assignees and the milestone may change: triage access or more. */
    triage: z.boolean().optional(),
    reason: z.string().max(256),
  }),
  /** Why a closed issue closed, as GitHub records it. */
  stateReason: z.enum(["completed", "not_planned", "reopened"]).nullable().optional(),
  /** The milestone's number, for a picker that changes it. */
  milestoneNumber: z.number().int().positive().nullable().optional(),
  relatedThreads: z.array(z.object({ id: ThreadId, title: text, archived: z.boolean() })).max(100),
  relatedThreadsTruncated: z.boolean(),
});
export type ForgeIssueDetail = z.infer<typeof ForgeIssueDetail>;
export const ForgeIssueList = z.object({
  repository: ForgeRepository,
  items: z.array(ForgeIssueRow).max(25),
  total: z.number().int().nonnegative(),
  nextPage: z.number().int().positive().optional(),
  counts: z.object({
    open: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
  }),
  canCreate: z.boolean(),
  unavailableReason: z.string().max(256),
  /** The login `gh` is signed in as, when GitHub said, so rows can be grouped as yours. */
  viewer: text.optional(),
  incomplete: z.boolean(),
  truncated: z.boolean(),
});
export type ForgeIssueList = z.infer<typeof ForgeIssueList>;
export const ForgeIssueEvent = z.object({
  id: z.string().max(256),
  kind: z.enum(["issue_comment", "activity"]),
  event: text,
  actor: text,
  at: text.nullable(),
  body: text.optional(),
  url: text.optional(),
  pullRequestUrl: text.optional(),
  raw: z.unknown(),
});
const scope = { workspaceId: WorkspaceId, repository: ForgeRepository.optional() };
export const ForgeIssueOperations = [
  z.object({ op: z.literal("forge.issue.list"), ...scope, query: ForgeIssueSearch }),
  z.object({ op: z.literal("forge.issue.detail"), ...scope, number: z.number().int().positive() }),
  z.object({
    op: z.literal("forge.issue.timeline"),
    ...scope,
    number: z.number().int().positive(),
    page: z.number().int().min(1).max(120).default(1),
  }),
  z.object({
    op: z.literal("forge.issue.actions"),
    ...scope,
    number: z.number().int().nonnegative().default(0),
  }),
] as const;
export const ForgeIssueWrite = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().min(1).max(256),
    body: z.string().max(64_000),
  }),
  z.object({
    action: z.literal("comment"),
    number: z.number().int().positive(),
    body: z.string().min(1).max(64_000),
  }),
  z.object({
    action: z.literal("edit"),
    number: z.number().int().positive(),
    expectedUpdatedAt: text,
    title: z.string().min(1).max(256),
    body: text,
    /**
     * The title and body the edit started from. With it, only a field someone else changed
     * since conflicts; activity elsewhere on the issue doesn't. Without it, any change does.
     */
    base: z.object({ title: text, body: text }).optional(),
  }),
  z.object({
    action: z.literal("state"),
    number: z.number().int().positive(),
    /** Kept for older clients; closing or reopening no longer depends on it. */
    expectedUpdatedAt: text,
    state: z.enum(["open", "closed"]),
    /** Why it closes; GitHub's default is completed. */
    reason: z.enum(["completed", "not_planned"]).optional(),
  }),
  /** Labels added and removed, applied to the issue as it is when the write lands. */
  z.object({
    action: z.literal("labels"),
    number: z.number().int().positive(),
    add: z.array(z.string().min(1).max(256)).max(100).default([]),
    remove: z.array(z.string().min(1).max(256)).max(100).default([]),
  }),
  /** Assignees added and removed, applied to the issue as it is when the write lands. */
  z.object({
    action: z.literal("assignees"),
    number: z.number().int().positive(),
    add: z.array(z.string().min(1).max(100)).max(10).default([]),
    remove: z.array(z.string().min(1).max(100)).max(100).default([]),
  }),
  z.object({
    action: z.literal("milestone"),
    number: z.number().int().positive(),
    milestone: z.number().int().positive().nullable(),
  }),
]);
export type ForgeIssueWrite = z.infer<typeof ForgeIssueWrite>;
export const ForgeIssueAction = z.object({
  id: CommandId,
  state: z.enum(["pending", "uncertain", "succeeded", "failed"]),
  action: z.enum(["create", "comment", "edit", "state", "labels", "assignees", "milestone"]),
  issue: ForgeIssueRef.optional(),
  error: z.string().max(256).optional(),
});
export type ForgeIssueAction = z.infer<typeof ForgeIssueAction>;
export const ForgeIssueCommands = [
  z.object({
    type: z.literal("forge.issue.write"),
    workspaceId: WorkspaceId,
    repository: ForgeRepository,
    input: ForgeIssueWrite,
  }),
  z.object({
    type: z.literal("forge.issue.reconcile"),
    workspaceId: WorkspaceId,
    repository: ForgeRepository,
    actionId: CommandId,
  }),
  z.object({ type: z.literal("forge.issue.link"), threadId: ThreadId, issue: ForgeIssueRef }),
] as const;
export const ForgeIssueResults = [
  z.object({ resource: z.literal("issueList"), value: ForgeIssueList }),
  z.object({ resource: z.literal("issueDetail"), value: ForgeIssueDetail }),
  z.object({
    resource: z.literal("issueTimeline"),
    events: z.array(ForgeIssueEvent).max(25),
    nextPage: z.number().int().positive().optional(),
    /** The conversation's last page, so the newest activity can be read first. */
    lastPage: z.number().int().positive().optional(),
    truncated: z.boolean(),
  }),
  z.object({ resource: z.literal("issueActions"), actions: z.array(ForgeIssueAction).max(25) }),
] as const;
