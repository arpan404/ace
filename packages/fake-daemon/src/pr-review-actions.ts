import type {
  CommandResult,
  ForgeComment,
  ForgeFile,
  ForgeReactionSummary,
  ForgeReviewAction,
  ForgeReviewAnchor,
  ForgeReviewState,
} from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";

type Result = Omit<CommandResult, "commandId">;
type Thread = PullRequestFixture["detail"]["status"]["reviewThreads"][number];
type Applied = { fixture: PullRequestFixture; result: Result };
const refused = (error: string): Result => ({ ok: false, error });

/** Lines a sample patch draws on each side, as GitHub numbers them for comment anchors. */
function drawnLines(patch: string): { LEFT: Set<number>; RIGHT: Set<number> } {
  const lines = { LEFT: new Set<number>(), RIGHT: new Set<number>() };
  let left = 0;
  let right = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
    } else if (text.startsWith("-")) lines.LEFT.add(left++);
    else if (text.startsWith("+")) lines.RIGHT.add(right++);
    else if (text.startsWith(" ")) {
      lines.LEFT.add(left++);
      lines.RIGHT.add(right++);
    }
  }
  return lines;
}
function anchored(files: readonly ForgeFile[], anchor: ForgeReviewAnchor): boolean {
  const patch = files.find((f) => f.path === anchor.path)?.patch;
  if (!patch) return false;
  const lines = drawnLines(patch);
  const start = anchor.startLine ?? anchor.line;
  return (
    start <= anchor.line &&
    lines[anchor.side].has(anchor.line) &&
    lines[anchor.startSide ?? anchor.side].has(start)
  );
}
function nextId(fixture: PullRequestFixture): number {
  const ids = [
    ...fixture.detail.status.comments.map((c) => c.id),
    ...fixture.detail.status.reviewThreads.flatMap((t) => t.comments.map((c) => c.id)),
  ];
  return Math.max(1_000, ...ids) + 1;
}
function withReview(fixture: PullRequestFixture, review: Partial<ForgeReviewState>) {
  return { ...fixture, review: { ...fixture.review, ...review } };
}
function withStatus(
  fixture: PullRequestFixture,
  status: Partial<PullRequestFixture["detail"]["status"]>,
): PullRequestFixture {
  return {
    ...fixture,
    detail: { ...fixture.detail, status: { ...fixture.detail.status, ...status } },
  };
}
/** A new thread at the anchor, opened by the viewer, which the viewer may resolve and hide. */
function openThread(fixture: PullRequestFixture, comment: ForgeComment, anchor: ForgeReviewAnchor) {
  const thread: Thread = {
    id: `RT_${comment.id}`,
    resolved: false,
    outdated: false,
    file: anchor.path,
    line: anchor.line,
    side: anchor.side,
    startLine: anchor.startLine ?? null,
    comments: [comment],
  };
  const status = fixture.detail.status;
  return withReview(
    withStatus(fixture, {
      comments: [...status.comments, comment],
      reviewThreads: [...status.reviewThreads, thread],
    }),
    {
      resolvableThreads: [...fixture.review.resolvableThreads, thread.id],
      hideable: [...(fixture.review.hideable ?? []), { source: "inline", commentId: comment.id }],
    },
  );
}
function findComment(fixture: PullRequestFixture, source: "issue" | "inline", id: number) {
  return fixture.detail.status.comments.find((c) => c.id === id && c.kind === source);
}
/** Replace (or drop, with `null`) one comment wherever the PR shows it. */
function mapComment(
  fixture: PullRequestFixture,
  id: number,
  change: (comment: ForgeComment) => ForgeComment | null,
): PullRequestFixture {
  const map = (list: ForgeComment[]) =>
    list.flatMap((c) => {
      if (c.id !== id) return [c];
      const next = change(c);
      return next ? [next] : [];
    });
  const status = fixture.detail.status;
  return withStatus(fixture, {
    comments: map(status.comments),
    reviewThreads: status.reviewThreads
      .map((t) => ({ ...t, comments: map(t.comments) }))
      .filter((t) => t.comments.length > 0),
  });
}
function react(
  reactions: ForgeReactionSummary[],
  action: Extract<ForgeReviewAction, { kind: "reaction.add" | "reaction.remove" }>,
): ForgeReactionSummary[] {
  const key = JSON.stringify(action.subject);
  const current = reactions.find((r) => JSON.stringify(r.subject) === key) ?? {
    subject: action.subject,
    groups: [],
  };
  const group = current.groups.find((g) => g.content === action.content);
  const adding = action.kind === "reaction.add";
  if (Boolean(group?.viewer) === adding) return reactions;
  const count = (group?.count ?? 0) + (adding ? 1 : -1);
  const groups = [
    ...current.groups.filter((g) => g.content !== action.content),
    ...(count > 0 ? [{ content: action.content, count, viewer: adding }] : []),
  ];
  const others = reactions.filter((r) => JSON.stringify(r.subject) !== key);
  return groups.length ? [...others, { subject: action.subject, groups }] : others;
}

/**
 * `forge.hosted.review` on a catalog PR, answered in memory as GitHub would: every later read of
 * the PR's detail and review state shows the result.
 */
export function applyHostedReview(
  fixture: PullRequestFixture,
  action: ForgeReviewAction,
  commandId: string,
  at: string,
): Applied {
  const review = fixture.review;
  const status = fixture.detail.status;
  const viewer = review.viewer;
  const open = status.state === "open" || status.state === "draft";
  const done = (next: PullRequestFixture): Applied => ({
    fixture: withReview(next, {
      operations: [{ id: commandId, state: "accepted" as const }, ...review.operations].slice(
        0,
        100,
      ),
    }),
    result: { ok: true },
  });
  const fail = (error: string): Applied => ({ fixture, result: refused(error) });
  const authored = (body: string, extra: Partial<ForgeComment>): ForgeComment => ({
    kind: "inline",
    id: nextId(fixture),
    body,
    author: viewer,
    authorAvatarUrl: `https://avatars.githubusercontent.com/${viewer}`,
    file: null,
    line: null,
    createdAt: at,
    updatedAt: at,
    replyTo: null,
    ...extra,
  });
  switch (action.kind) {
    case "draft.save": {
      const drafts = review.drafts.filter((d) => d.id !== action.draft.id);
      if (drafts.length >= 100) return fail("forge_limit");
      return {
        fixture: withReview(fixture, { drafts: [...drafts, action.draft] }),
        result: { ok: true },
      };
    }
    case "draft.delete":
      return {
        fixture: withReview(fixture, { drafts: review.drafts.filter((d) => d.id !== action.id) }),
        result: { ok: true },
      };
    case "reconcile":
      return review.operations.some((o) => o.id === action.operationId)
        ? { fixture, result: { ok: true } }
        : fail("forge_not_found");
    case "submit": {
      if (!open || action.headSha !== review.headSha) return fail("forge_conflict");
      if (!review.canComment || (!review.canReview && action.event !== "COMMENT"))
        return fail("forge_forbidden");
      const drafts = review.drafts.filter((d) => action.draftIds.includes(d.id));
      if (drafts.length !== action.draftIds.length) return fail("forge_conflict");
      if (
        drafts.some((d) => d.anchor.commit !== action.headSha || !anchored(fixture.files, d.anchor))
      )
        return fail("forge_conflict");
      let next = withReview(fixture, {
        drafts: review.drafts.filter((d) => !action.draftIds.includes(d.id)),
      });
      for (const draft of drafts) {
        const comment = authored(draft.body, {
          id: nextId(next),
          file: draft.anchor.path,
          line: draft.anchor.line,
        });
        next = openThread(next, comment, draft.anchor);
      }
      const states = {
        COMMENT: "COMMENTED",
        APPROVE: "APPROVED",
        REQUEST_CHANGES: "CHANGES_REQUESTED",
      };
      if (action.body || action.event !== "COMMENT")
        next = withStatus(next, {
          comments: [
            ...next.detail.status.comments,
            authored(action.body, {
              kind: "review",
              id: nextId(next),
              reviewState: states[action.event],
            }),
          ],
        });
      return done(next);
    }
    case "conversation": {
      if (!review.canComment) return fail("forge_forbidden");
      const comment = authored(action.body, { kind: "issue" });
      return done(
        withReview(withStatus(fixture, { comments: [...status.comments, comment] }), {
          hideable: [...(review.hideable ?? []), { source: "issue", commentId: comment.id }],
        }),
      );
    }
    case "line.comment": {
      if (!open || action.headSha !== review.headSha) return fail("forge_conflict");
      if (!review.canComment) return fail("forge_forbidden");
      if (action.anchor.commit !== action.headSha || !anchored(fixture.files, action.anchor))
        return fail("forge_conflict");
      const comment = authored(action.body, { file: action.anchor.path, line: action.anchor.line });
      // Posting one comment never touches the pending drafts.
      return done(openThread(fixture, comment, action.anchor));
    }
    case "reply": {
      if (!review.canComment) return fail("forge_forbidden");
      const thread = status.reviewThreads.find((t) =>
        t.comments.some((c) => c.id === action.commentId),
      );
      if (!thread) return fail("forge_not_found");
      const comment = authored(action.body, {
        file: thread.file,
        line: thread.line,
        replyTo: action.commentId,
      });
      return done(
        withReview(
          withStatus(fixture, {
            comments: [...status.comments, comment],
            reviewThreads: status.reviewThreads.map((t) =>
              t === thread ? { ...t, comments: [...t.comments, comment] } : t,
            ),
          }),
          { hideable: [...(review.hideable ?? []), { source: "inline", commentId: comment.id }] },
        ),
      );
    }
    case "comment.edit":
    case "comment.delete": {
      const comment = findComment(fixture, action.source, action.commentId);
      if (!comment || comment.author !== viewer) return fail("forge_forbidden");
      if (comment.body !== action.expectedBody) return fail("forge_conflict");
      const next = mapComment(fixture, action.commentId, (c) =>
        action.kind === "comment.edit" ? { ...c, body: action.body, updatedAt: at } : null,
      );
      if (action.kind === "comment.edit") return done(next);
      const gone = (c: { commentId: number }) => c.commentId !== action.commentId;
      const threads = new Set(next.detail.status.reviewThreads.map((t) => t.id));
      return done(
        withReview(next, {
          hidden: review.hidden?.filter(gone) ?? null,
          hideable: review.hideable?.filter(gone) ?? null,
          resolvableThreads: review.resolvableThreads.filter((id) => threads.has(id)),
        }),
      );
    }
    case "comment.hide":
    case "comment.unhide": {
      if (!findComment(fixture, action.source, action.commentId)) return fail("forge_not_found");
      const same = (c: { source: string; commentId: number }) =>
        c.source === action.source && c.commentId === action.commentId;
      if (!review.hideable?.some(same)) return fail("forge_forbidden");
      const others = (review.hidden ?? []).filter((c) => !same(c));
      return done(
        withReview(fixture, {
          hidden:
            action.kind === "comment.hide"
              ? [
                  ...others,
                  { source: action.source, commentId: action.commentId, reason: action.reason },
                ]
              : others,
        }),
      );
    }
    case "thread.resolve":
    case "thread.unresolve": {
      if (!review.resolvableThreads.includes(action.threadId)) return fail("forge_forbidden");
      const resolved = action.kind === "thread.resolve";
      return done(
        withStatus(fixture, {
          reviewThreads: status.reviewThreads.map((t) =>
            t.id === action.threadId ? { ...t, resolved } : t,
          ),
        }),
      );
    }
    case "file.view":
    case "file.unview": {
      if (action.headSha !== review.headSha) return fail("forge_conflict");
      if (!fixture.files.some((f) => f.path === action.path)) return fail("forge_not_found");
      const state = action.kind === "file.view" ? "VIEWED" : "UNVIEWED";
      const viewed = (review.viewed ?? []).filter((f) => f.path !== action.path);
      return done(withReview(fixture, { viewed: [...viewed, { path: action.path, state }] }));
    }
    case "reaction.add":
    case "reaction.remove":
      return done(withReview(fixture, { reactions: react(review.reactions ?? [], action) }));
    case "reviewers.request": {
      const known = new Set(fixture.detail.reviewers.map((r) => r.toLowerCase()));
      const added = action.reviewers.filter((r) => !known.has(r.toLowerCase()));
      return done({
        ...fixture,
        detail: { ...fixture.detail, reviewers: [...fixture.detail.reviewers, ...added] },
      });
    }
    case "suggestions.apply":
      // Applying suggestions makes a commit; the sample PRs have no branch to commit to.
      return fail("forge_unsupported");
  }
}
