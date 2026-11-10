import { sha, must } from "./gitlab-records.ts";
import { ForgeError } from "./errors.ts";
import { redactData } from "./redact.ts";
import { z } from "zod";
import type { ForgeActivity } from "@ace/protocol/forge-browser";
import { ForgeComment, ForgeReviewThread } from "@ace/protocol/forge";
import { clipText } from "./host-text.ts";
const text = z.string();
export const GitLabUser = z.looseObject({
  id: z.number().int().positive(),
  username: text,
  avatar_url: text.nullable().optional(),
});
export const GitLabPosition = z.looseObject({
  base_sha: sha,
  start_sha: sha,
  head_sha: sha,
  position_type: text,
  old_path: text,
  new_path: text,
  old_line: z.number().int().nullable().optional(),
  new_line: z.number().int().nullable().optional(),
  line_range: z
    .looseObject({
      start: z.looseObject({
        type: text.optional(),
        old_line: z.number().int().nullable().optional(),
        new_line: z.number().int().nullable().optional(),
      }),
    })
    .optional(),
});
export const GitLabNote = z.looseObject({
  id: z.number().int().positive(),
  body: text,
  author: GitLabUser.nullable(),
  created_at: text,
  updated_at: text,
  system: z.boolean(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().optional(),
  position: GitLabPosition.nullable().optional(),
});
export const GitLabDiscussion = z.looseObject({
  id: text,
  individual_note: z.boolean(),
  notes: z.array(GitLabNote).max(2000),
});
export const GitLabApprovals = z.looseObject({
  approved: z.boolean().optional(),
  approvals_left: z.number().int().nonnegative().optional(),
  approved_by: z
    .array(z.looseObject({ user: GitLabUser, approved_at: text.nullable().optional() }))
    .max(100),
});
export const GitLabApprovalState = z.looseObject({
  rules: z
    .array(
      z.looseObject({
        approved: z.boolean(),
        approvals_required: z.number().int().nonnegative().optional(),
      }),
    )
    .max(100),
});
export const GitLabCommit = z.looseObject({
  id: sha,
  message: text,
  author_name: text,
  authored_date: text.nullable(),
  web_url: text,
});

/** System notes stay in activity; human notes retain their provider ids for replies. */
export function conversation(discussions: z.infer<typeof GitLabDiscussion>[], head: string) {
  const comments: z.infer<typeof ForgeComment>[] = [];
  const reviewThreads: z.infer<typeof ForgeReviewThread>[] = [];
  const events: ForgeActivity[] = [];
  for (const discussion of discussions) {
    const first = discussion.notes.find((n) => !n.system);
    const position = first?.position;
    const notes = discussion.notes.flatMap((note) => {
      if (note.system) {
        events.push({
          id: String(note.id),
          event: "system",
          actor: clipText(note.author?.username ?? "deleted user"),
          subject: clipText(note.body),
          at: note.created_at,
          raw: redactData(note),
        });
        return [];
      }
      const p = note.position ?? position;
      return [
        must(
          ForgeComment.safeParse({
            id: note.id,
            kind: p ? "inline" : "issue",
            body: clipText(note.body),
            author: clipText(note.author?.username ?? "deleted user"),
            ...(note.author?.avatar_url
              ? { authorAvatarUrl: clipText(note.author.avatar_url) }
              : {}),
            file: p ? clipText(p.new_line != null ? p.new_path : p.old_path) : null,
            line: p ? (p.new_line ?? p.old_line ?? null) : null,
            createdAt: note.created_at,
            updatedAt: note.updated_at,
            replyTo: first && first.id !== note.id ? first.id : null,
          }),
        ),
      ];
    });
    comments.push(...notes);
    if (position && first) {
      const right = position.new_line != null;
      const start = position.line_range?.start;
      reviewThreads.push(
        must(
          ForgeReviewThread.safeParse({
            id: discussion.id,
            resolved:
              discussion.notes.filter((n) => n.resolvable).every((n) => n.resolved === true) &&
              first.resolvable === true,
            outdated: position.head_sha.toLowerCase() !== head.toLowerCase(),
            file: clipText(right ? position.new_path : position.old_path),
            line: right ? position.new_line : (position.old_line ?? null),
            side: right ? "RIGHT" : "LEFT",
            originalLine: right ? position.new_line : (position.old_line ?? null),
            originalCommit: position.head_sha,
            ...(start
              ? {
                  startLine:
                    start.type === "new" || (start.type === undefined && start.new_line != null)
                      ? start.new_line
                      : start.old_line,
                  startSide:
                    start.type === "new" || (start.type === undefined && start.new_line != null)
                      ? "RIGHT"
                      : "LEFT",
                }
              : {}),
            comments: notes,
          }),
        ),
      );
    }
  }
  if (comments.length > 2000 || reviewThreads.length > 2000) throw new ForgeError("limit");
  return { comments, reviewThreads, events };
}

export function approvalDecision(
  approvals: z.infer<typeof GitLabApprovals>,
  state?: z.infer<typeof GitLabApprovalState>,
): "APPROVED" | "REVIEW_REQUIRED" | null {
  if (state?.rules.length)
    return state.rules.every((rule) => rule.approved) ? "APPROVED" : "REVIEW_REQUIRED";
  if (approvals.approved !== undefined) return approvals.approved ? "APPROVED" : "REVIEW_REQUIRED";
  if (approvals.approvals_left !== undefined)
    return approvals.approvals_left === 0 ? "APPROVED" : "REVIEW_REQUIRED";
  return null;
}
