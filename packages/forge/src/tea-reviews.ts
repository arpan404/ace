import { z } from "zod";
import { ForgeComment, ForgeReviewThread, type ForgeRepository } from "@ace/protocol/forge";
import type { ForgeReviewAction, ForgeReviewDraft } from "@ace/protocol/forge-review";
import type { CommandRunner } from "./command.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
import type { HostApiWrite } from "./read-only-api.ts";
import { teaGet, teaResponse } from "./tea-api.ts";
import { decode, pull } from "./tea-records.ts";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";

export const teaReviewWrites: readonly HostApiWrite[] = [
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/issues\/[1-9]\d*\/comments$/ },
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/pulls\/[1-9]\d*\/reviews$/ },
  {
    method: "POST",
    endpoint: /^repos\/[^/?]+\/[^/?]+\/pulls\/[1-9]\d*\/comments\/[1-9]\d*\/replies$/,
  },
];
const person = z.object({ login: z.string() });
const comment = z.looseObject({
  id: z.number().int().positive(),
  body: z.string(),
  user: person.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const review = z.looseObject({
  id: z.number().int().positive(),
  body: z.string().nullable(),
  state: z.string(),
  user: person.nullable(),
  submitted_at: z.string(),
  updated_at: z.string(),
  comments_count: z.number().int().nonnegative(),
  dismissed: z.boolean().optional(),
});
const inline = comment.extend({
  path: z.string(),
  position: z.number().int(),
  original_position: z.number().int(),
  commit_id: z.string(),
  original_commit_id: z.string(),
  resolver: person.nullable().optional(),
  diff_hunk: z.string().optional(),
});
const marker = (id: string) =>
  `<!-- ace-review-action:${encodeURIComponent(z.string().min(1).max(256).parse(id))} -->`;

/** Gitea/Forgejo review transport. Local drafts and uncertain receipts belong to the daemon. */
export class TeaReviews {
  private root: string;
  private options: { repository: ForgeRepository; runner: CommandRunner; login: string };
  constructor(options: { repository: ForgeRepository; runner: CommandRunner; login: string }) {
    this.options = options;
    this.root = `repos/${encodeURIComponent(options.repository.owner)}/${encodeURIComponent(options.repository.name)}`;
  }
  private get(path: string, signal: AbortSignal) {
    return teaGet(this.options.runner, this.options.login, `${this.root}/${path}`, signal);
  }
  private async pr(number: number, signal: AbortSignal) {
    z.number().int().positive().parse(number);
    const p = decode(pull, (await this.get(`pulls/${number}`, signal)).body);
    if (p.number !== number) throw new ForgeError("invalid_data");
    return p;
  }
  private async all<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.get(`${path}?page=${page}&limit=100`, signal);
      const data = decode(z.array(schema).max(100), response.body);
      rows.push(...data);
      if (rows.length > 2000) throw new ForgeError("limit");
      if (response.total !== undefined ? page * 100 >= response.total : data.length < 100)
        return rows;
    }
    throw new ForgeError("limit");
  }
  async conversation(number: number, signal: AbortSignal) {
    const p = await this.pr(number, signal);
    const comments = (await this.all(`issues/${number}/comments`, comment, signal)).map((c) =>
      decode(ForgeComment, {
        kind: "issue",
        id: c.id,
        body: clipText(c.body),
        author: clipText(c.user?.login ?? ""),
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        file: null,
        line: null,
        replyTo: null,
      }),
    );
    const threads: z.infer<typeof ForgeReviewThread>[] = [];
    const reviews = await this.all(`pulls/${number}/reviews`, review, signal);
    if (reviews.length > 100) throw new ForgeError("limit");
    for (const r of reviews) {
      if (r.state === "PENDING" || r.state === "REQUEST_REVIEW") continue;
      comments.push(
        decode(ForgeComment, {
          kind: "review",
          id: r.id,
          body: clipText(r.body ?? ""),
          author: clipText(r.user?.login ?? ""),
          createdAt: r.submitted_at,
          updatedAt: r.updated_at,
          file: null,
          line: null,
          replyTo: null,
          reviewState: r.dismissed
            ? "DISMISSED"
            : r.state === "REQUEST_CHANGES"
              ? "CHANGES_REQUESTED"
              : r.state === "COMMENT"
                ? "COMMENTED"
                : r.state,
        }),
      );
      if (!r.comments_count) continue;
      for (const c of await this.all(`pulls/${number}/reviews/${r.id}/comments`, inline, signal)) {
        const line = c.position > 0 ? c.position : null;
        const mapped = decode(ForgeComment, {
          kind: "inline",
          id: c.id,
          body: clipText(c.body),
          author: clipText(c.user?.login ?? ""),
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          file: clipText(c.path),
          line,
          replyTo: null,
        });
        comments.push(mapped);
        threads.push(
          decode(ForgeReviewThread, {
            id: String(c.id),
            resolved: c.resolver != null,
            outdated: c.commit_id !== p.head.sha,
            file: clipText(c.path),
            line,
            originalLine: c.original_position > 0 ? c.original_position : null,
            originalCommit: c.original_commit_id,
            ...(c.diff_hunk ? { hunk: c.diff_hunk.slice(-20000) } : {}),
            comments: [mapped],
          }),
        );
      }
    }
    const latest = await this.pr(number, signal);
    if (latest.head.sha !== p.head.sha) throw new ForgeError("head_moved");
    if (comments.length > 2000 || threads.length > 2000) throw new ForgeError("limit");
    return { comments, reviewThreads: threads };
  }
  async host(number: number, signal: AbortSignal) {
    const p = await this.pr(number, signal);
    const viewer = decode(
      person,
      (await teaGet(this.options.runner, this.options.login, "user", signal)).body,
    ).login;
    const repo = decode(
      z.object({ archived: z.boolean(), permissions: z.object({ push: z.boolean() }) }),
      (await teaGet(this.options.runner, this.options.login, this.root, signal)).body,
    );
    return {
      viewer,
      pr: {
        headRefOid: p.head.sha,
        state: p.merged ? "MERGED" : p.state.toUpperCase(),
        viewerCanComment: !repo.archived && repo.permissions.push,
        viewerDidAuthor: p.user?.login === viewer,
      },
      threads: [],
    };
  }
  async viewedNow(_number: number, _signal: AbortSignal): Promise<never> {
    throw new ForgeError("unsupported");
  }
  async decorations(_number: number, _signal: AbortSignal) {
    return { reactions: null, hidden: null, hideable: null };
  }
  async moveDrafts(
    _number: number,
    _head: string,
    _drafts: readonly ForgeReviewDraft[],
    _signal: AbortSignal,
  ): Promise<never> {
    throw new ForgeError("unsupported");
  }
  async write(
    number: number,
    action: ForgeReviewAction,
    drafts: readonly ForgeReviewDraft[],
    operation: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch?: WriteDispatch,
  ) {
    const host = await this.host(number, signal);
    if (!host.pr.viewerCanComment || !allowed()) throw new ForgeError("forbidden");
    let path: string;
    let body: object;
    const text =
      "body" in action && typeof action.body === "string"
        ? `${action.body}\n\n${marker(operation)}`
        : marker(operation);
    if (action.kind === "conversation") {
      path = `issues/${number}/comments`;
      body = { body: text };
    } else if (action.kind === "reply") {
      if (action.pendingReview) throw new ForgeError("unsupported");
      const source = (await this.conversation(number, signal)).comments.find(
        (c) => c.id === action.commentId && c.kind === "inline",
      );
      if (!source) throw new ForgeError("not_found");
      path = `pulls/${number}/comments/${action.commentId}/replies`;
      body = { body: text };
    } else if (action.kind === "line.comment") {
      if (action.anchor.startLine !== undefined || action.anchor.commit !== action.headSha)
        throw new ForgeError("unsupported");
      path = `pulls/${number}/reviews`;
      body = {
        event: "COMMENT",
        commit_id: action.headSha,
        body: marker(operation),
        comments: [
          {
            path: action.anchor.path,
            body: text,
            old_position: action.anchor.side === "LEFT" ? action.anchor.line : 0,
            new_position: action.anchor.side === "RIGHT" ? action.anchor.line : 0,
          },
        ],
      };
    } else if (action.kind === "submit") {
      if (drafts.length || action.draftIds.length) throw new ForgeError("unsupported");
      if (host.pr.viewerDidAuthor && action.event !== "COMMENT") throw new ForgeError("forbidden");
      path = `pulls/${number}/reviews`;
      body = {
        event: action.event === "APPROVE" ? "APPROVED" : action.event,
        commit_id: action.headSha,
        body: text,
      };
    } else throw new ForgeError("unsupported");
    if ("headSha" in action) {
      if (
        host.pr.state !== "OPEN" ||
        host.pr.headRefOid !== action.headSha ||
        (await this.pr(number, signal)).head.sha !== action.headSha
      )
        throw new ForgeError("head_moved");
    }
    signal.throwIfAborted();
    if (!allowed()) throw new ForgeError("forbidden");
    const result = await this.options.runner({
      command: "tea",
      args: [
        "api",
        `${this.root}/${path}`,
        "--method",
        "POST",
        "--login",
        this.options.login,
        "--include",
        "--data",
        "@-",
      ],
      input: JSON.stringify(body),
      mode: "json",
      signal,
      ...(dispatch ? { dispatch } : {}),
    });
    if (result.identityChanged) throw new ForgeError("outcome_uncertain");
    teaResponse(result);
  }
  async reconcile(
    number: number,
    action: ForgeReviewAction,
    operation: string,
    signal: AbortSignal,
    _drafts: readonly ForgeReviewDraft[],
  ) {
    if (!["conversation", "reply", "line.comment", "submit"].includes(action.kind))
      throw new ForgeError("unsupported");
    return (await this.conversation(number, signal)).comments.some((c) =>
      c.body.includes(marker(operation)),
    );
  }
}
