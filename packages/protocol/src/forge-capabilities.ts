import { z } from "zod";

/**
 * What ace can do with one repository's host (ADR 0117). The daemon says which of these a
 * repository supports; clients show a control only when its capability is listed, never by
 * checking for GitHub. A capability the client doesn't know is ignored.
 */
export const ForgeCapability = z.enum([
  /** Review lists, detail, state and checkout. */
  "reviews.read",
  /** A review's changed files and diffs. */
  "reviews.files",
  /** A review's commits. */
  "reviews.commits",
  /** Comments and review threads on a review, read. */
  "reviews.comments.read",
  /** Comment, reply, resolve and reopen threads on a review. */
  "reviews.comments.write",
  /** Approvals and requested reviewers, read. */
  "reviews.approvals.read",
  /** Approve, request changes, request reviewers. */
  "reviews.approvals.write",
  /** CI checks or pipelines and their logs. */
  "reviews.checks",
  /** Re-run or cancel checks. */
  "reviews.checks.write",
  /** Open a new review. */
  "reviews.create",
  /** Edit title, body, labels, draft state; close and reopen. */
  "reviews.edit",
  /** Merge, and the merge state that decides whether it can. */
  "reviews.merge",
  /** Merge automatically once checks pass. */
  "reviews.autoMerge",
  /** Stacked reviews. */
  "reviews.stacks",
  /** Suggested changes applied from comments. */
  "reviews.suggestions",
  /** Issue lists, detail and timeline. */
  "issues.read",
  /** Create, comment, close, reopen, label and assign issues. */
  "issues.write",
  /** The host's notifications or to-dos as an inbox. */
  "inbox",
  /** Emoji reactions, read and written. */
  "reactions",
  /** Images and attachments in text, resolved through the host. */
  "media",
]);
export type ForgeCapability = z.infer<typeof ForgeCapability>;

/** A repository's capabilities on the wire: unknown values from a newer daemon are dropped. */
export const ForgeCapabilities = z
  .array(z.string().max(64))
  .max(64)
  .transform((values) =>
    values.flatMap((value) => {
      const known = ForgeCapability.safeParse(value);
      return known.success ? [known.data] : [];
    }),
  );
