import { z } from "zod";
import { ForgeRepository } from "./forge.ts";
import { CommandId, WorkspaceId } from "./ids.ts";

const text = z.string().max(65_536);
const host = z
  .string()
  .regex(/^[a-zA-Z0-9.-]+$/)
  .max(253);
/** GitHub's notification thread id: digits, kept as text. */
export const ForgeInboxThreadId = z.string().regex(/^\d{1,32}$/);
export type ForgeInboxThreadId = z.infer<typeof ForgeInboxThreadId>;
/**
 * Why GitHub notified: `review_requested`, `mention`, `team_mention`, `author`, `comment`,
 * `assign`, `state_change`, `ci_activity`, `subscribed`, `manual`, `security_alert` and any word
 * GitHub adds later, kept as GitHub sent it.
 */
export const ForgeInboxReason = z.string().min(1).max(64);
/**
 * What the notification is about: `PullRequest`, `Issue`, `Release`, `Discussion`, `Commit`,
 * `CheckSuite` and any type GitHub adds later, kept as GitHub sent it.
 */
export const ForgeInboxSubjectType = z.string().min(1).max(64);
/** A pull request's or issue's state when GitHub said; other subjects have none. */
export const ForgeInboxSubjectState = z.enum(["open", "draft", "merged", "closed"]);
export type ForgeInboxSubjectState = z.infer<typeof ForgeInboxSubjectState>;
export const ForgeInboxRow = z.object({
  id: ForgeInboxThreadId,
  repository: ForgeRepository,
  type: ForgeInboxSubjectType,
  title: text,
  /** The pull request's or issue's number, read from the subject's address. */
  number: z.number().int().positive().optional(),
  state: ForgeInboxSubjectState.optional(),
  reason: ForgeInboxReason,
  unread: z.boolean(),
  updatedAt: text,
  lastReadAt: text.nullable(),
  /** Where the subject opens on GitHub, when its address could be worked out. */
  url: text.optional(),
});
export type ForgeInboxRow = z.infer<typeof ForgeInboxRow>;
export const ForgeInboxQuery = z.object({
  /** Read notifications too, not only unread ones. */
  all: z.boolean().default(false),
  /** Only threads the person takes part in or is mentioned in. */
  participating: z.boolean().default(false),
  /** One repository's notifications. */
  repository: ForgeRepository.optional(),
  /** Only notifications updated at or after this time (ISO 8601). */
  since: z.iso.datetime().optional(),
  page: z.number().int().min(1).max(20).default(1),
});
export type ForgeInboxQuery = z.infer<typeof ForgeInboxQuery>;
export const ForgeInboxList = z.object({
  host,
  /** The project's own repository, so its rows open without naming it. */
  projectRepository: ForgeRepository.optional(),
  items: z.array(ForgeInboxRow).max(50),
  nextPage: z.number().int().positive().optional(),
  /** How long GitHub asks clients to wait before asking again, in seconds. */
  pollSeconds: z.number().int().min(1).max(3_600),
  /** The page GitHub answered "not modified" for: the rows are the ones read before. */
  unchanged: z.boolean(),
});
export type ForgeInboxList = z.infer<typeof ForgeInboxList>;
/** Without a host, the project's own repository's host. */
const scope = { workspaceId: WorkspaceId, host: host.optional() };
export const ForgeInboxOperations = [
  z.object({ op: z.literal("forge.inbox.list"), ...scope, query: ForgeInboxQuery }),
] as const;
export const ForgeInboxWrite = z.discriminatedUnion("action", [
  /** Mark one thread read. GitHub has no way back to unread. */
  z.object({ action: z.literal("read"), id: ForgeInboxThreadId }),
  /** Mark one thread done: it leaves the inbox until something new happens on it. */
  z.object({ action: z.literal("done"), id: ForgeInboxThreadId }),
  /** Stop notifications for one thread. */
  z.object({ action: z.literal("unsubscribe"), id: ForgeInboxThreadId }),
  /** Mark everything read up to `before`, in one repository or everywhere. */
  z.object({
    action: z.literal("read-all"),
    before: z.iso.datetime(),
    repository: ForgeRepository.optional(),
  }),
]);
export type ForgeInboxWrite = z.infer<typeof ForgeInboxWrite>;
/**
 * A write's receipt. Every inbox write sets a state rather than adding to one, so an
 * `uncertain` write is safe to send again, by the person, never automatically.
 */
export const ForgeInboxAction = z.object({
  id: CommandId,
  state: z.enum(["succeeded", "failed", "uncertain"]),
  action: z.enum(["read", "done", "unsubscribe", "read-all"]),
  error: z.string().max(256).optional(),
});
export type ForgeInboxAction = z.infer<typeof ForgeInboxAction>;
export const ForgeInboxCommands = [
  z.object({
    type: z.literal("forge.inbox.write"),
    workspaceId: WorkspaceId,
    host: host.optional(),
    input: ForgeInboxWrite,
  }),
] as const;
export type ForgeInboxCommand = z.infer<(typeof ForgeInboxCommands)[number]>;
export const ForgeInboxResults = [
  z.object({ resource: z.literal("inboxList"), value: ForgeInboxList }),
] as const;
