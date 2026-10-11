import { assertGraphqlResult } from "./graphql-errors.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ForgePrRef } from "@ace/protocol/forge";
import type { ForgeReviewAction, ForgeReviewDraft } from "@ace/protocol/forge-review";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";
import { ReadBudget } from "./read-budget.ts";
import { validHostedAnchor } from "./review-anchor.ts";
const text = z.string().max(65_536);
const positive = z.number().int().positive();
const Comment = z.looseObject({
  id: positive,
  body: text,
  user: z.looseObject({ login: text }).nullable(),
  pull_request_url: text.optional(),
  issue_url: text.optional(),
  in_reply_to_id: positive.optional(),
});
const Review = z.looseObject({
  id: positive,
  body: text.nullable(),
  commit_id: text,
  state: text,
  user: z.looseObject({ login: text }).nullable(),
});
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: text.nullable() });
const Host = z.object({
  data: z.object({
    viewer: z.object({ login: text }),
    repository: z.object({
      pullRequest: z.object({
        id: text,
        headRefOid: text,
        state: text,
        viewerDidAuthor: z.boolean(),
        locked: z.boolean(),
        viewerCanUpdate: z.boolean(),
        reviewThreads: z.object({
          nodes: z
            .array(
              z.object({
                id: text,
                isResolved: z.boolean(),
                viewerCanResolve: z.boolean(),
                viewerCanUnresolve: z.boolean(),
              }),
            )
            .max(100),
          pageInfo: PageInfo,
        }),
      }),
    }),
  }),
});
const Files = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: text,
        files: z.object({
          nodes: z.array(z.object({ path: text, viewerViewedState: text })).max(100),
          pageInfo: PageInfo,
        }),
      }),
    }),
  }),
});
function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
export function reviewWriteMarker(operationId: string): string {
  return `<!-- ace-write:${createHash("sha256").update(operationId).digest("hex")} -->`;
}
/** GitHub writes through the installed CLI. All lookups stay scoped to the selected PR. */
export class GitHubReviews {
  readonly #api: GhApi;
  readonly #root: string;
  readonly #pr: (number: number) => ForgePrRef;
  constructor(api: GhApi, pr: (number: number) => ForgePrRef) {
    this.#api = api;
    this.#pr = pr;
    const repo = pr(1).repository;
    this.#root = `repos/${repo.owner}/${repo.name}`;
  }
  async host(number: number, signal: AbortSignal) {
    const { owner, name } = this.#pr(number).repository;
    let after: string | null = null;
    const threads: {
      id: string;
      isResolved: boolean;
      viewerCanResolve: boolean;
      viewerCanUnresolve: boolean;
    }[] = [];
    const budget = new ReadBudget();
    for (let page = 0; page < 20; page++) {
      const result = await this.#api.request("graphql", signal, {
        query: `query($owner:String!,$name:String!,$number:Int!,$after:String){ viewer { login } repository(owner:$owner,name:$name){ pullRequest(number:$number){ id headRefOid state viewerDidAuthor locked viewerCanUpdate reviewThreads(first:100,after:$after){ nodes { id isResolved viewerCanResolve viewerCanUnresolve } pageInfo { hasNextPage endCursor } } } } }`,
        variables: { owner, name, number, after },
      });
      budget.add(result.bytes);
      const data = decode(Host, result.body).data;
      const pr = data.repository.pullRequest;
      threads.push(...pr.reviewThreads.nodes);
      if (!pr.reviewThreads.pageInfo.hasNextPage)
        return {
          viewer: data.viewer.login,
          pr: { ...pr, viewerCanComment: !pr.locked || pr.viewerCanUpdate },
          threads,
        };
      const next = pr.reviewThreads.pageInfo.endCursor;
      if (!next || next === after) throw new ForgeError("invalid_data");
      after = next;
    }
    throw new ForgeError("limit");
  }
  async viewed(number: number, headSha: string, signal: AbortSignal) {
    const { owner, name } = this.#pr(number).repository;
    let after: string | null = null;
    const files: { path: string; state: string }[] = [];
    const budget = new ReadBudget();
    for (let page = 0; page < 30; page++) {
      const result = await this.#api.request("graphql", signal, {
        query: `query($owner:String!,$name:String!,$number:Int!,$after:String){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ headRefOid files(first:100,after:$after){ nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } } } } }`,
        variables: { owner, name, number, after },
      });
      budget.add(result.bytes);
      const pr = decode(Files, result.body).data.repository.pullRequest;
      if (pr.headRefOid !== headSha) throw new ForgeError("conflict");
      files.push(...pr.files.nodes.map((f) => ({ path: f.path, state: f.viewerViewedState })));
      if (!pr.files.pageInfo.hasNextPage) return files;
      const next = pr.files.pageInfo.endCursor;
      if (!next || next === after) throw new ForgeError("invalid_data");
      after = next;
    }
    throw new ForgeError("limit");
  }
  async #records<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]> {
    const pages = await this.#api.pages(path, signal, new ReadBudget());
    return pages.flatMap((p) => decode(z.array(schema).max(100), p.body));
  }
  async #comment(number: number, source: "inline" | "issue", id: number, signal: AbortSignal) {
    const path = source === "inline" ? `pulls/${number}/comments` : `issues/${number}/comments`;
    return (await this.#records(`${this.#root}/${path}?per_page=100`, Comment, signal)).find(
      (c) => c.id === id,
    );
  }
  async reconcile(
    number: number,
    action: ForgeReviewAction,
    operationId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const marker = reviewWriteMarker(operationId);
    const host = await this.host(number, signal);
    if (action.kind === "submit") {
      const states = {
        COMMENT: "COMMENTED",
        APPROVE: "APPROVED",
        REQUEST_CHANGES: "CHANGES_REQUESTED",
      };
      return (
        await this.#records(`${this.#root}/pulls/${number}/reviews?per_page=100`, Review, signal)
      ).some(
        (r) =>
          r.user?.login === host.viewer &&
          r.body?.includes(marker) &&
          r.commit_id === action.headSha &&
          r.state === states[action.event],
      );
    }
    if (action.kind === "conversation" || action.kind === "reply") {
      const path =
        action.kind === "reply" ? `pulls/${number}/comments` : `issues/${number}/comments`;
      return (await this.#records(`${this.#root}/${path}?per_page=100`, Comment, signal)).some(
        (c) =>
          c.user?.login === host.viewer &&
          c.body.includes(marker) &&
          (action.kind !== "reply" || c.in_reply_to_id === action.commentId),
      );
    }
    if (action.kind === "comment.edit" || action.kind === "comment.delete") {
      const c = await this.#comment(number, action.source, action.commentId, signal);
      return action.kind === "comment.delete"
        ? !c
        : c?.user?.login === host.viewer && c.body === action.body;
    }
    if (action.kind === "thread.resolve" || action.kind === "thread.unresolve") {
      const t = host.threads.find((entry) => entry.id === action.threadId);
      return t?.isResolved === (action.kind === "thread.resolve");
    }
    if (action.kind === "file.view" || action.kind === "file.unview") {
      const file = (await this.viewed(number, action.headSha, signal)).find(
        (f) => f.path === action.path,
      );
      return file?.state === (action.kind === "file.view" ? "VIEWED" : "UNVIEWED");
    }
    return false;
  }
  async #mutation(name: string, input: Record<string, unknown>, signal: AbortSignal) {
    const response = await this.#api.request("graphql", signal, {
      query: `mutation($input:${name[0]?.toUpperCase()}${name.slice(1)}Input!){ ${name}(input:$input){ clientMutationId } }`,
      variables: { input },
    });
    assertGraphqlResult(response.body);
    const result = decode(
      z.object({
        data: z.record(z.string(), z.object({ clientMutationId: text.nullable() }).nullable()),
      }),
      response.body,
    );
    if (!result.data[name]) throw new ForgeError("invalid_data");
  }
  async write(
    number: number,
    action: ForgeReviewAction,
    drafts: ForgeReviewDraft[],
    operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    beforeWrite: () => void = () => {},
  ) {
    const host = await this.host(number, signal);
    const dispatch = () => {
      if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
      beforeWrite();
    };
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    const marker = reviewWriteMarker(operationId);
    if (action.kind === "submit") {
      if (host.pr.state !== "OPEN" || host.pr.headRefOid !== action.headSha)
        throw new ForgeError("conflict");
      if (!host.pr.viewerCanComment || (host.pr.viewerDidAuthor && action.event !== "COMMENT"))
        throw new ForgeError("forbidden");
      if (
        drafts.length !== action.draftIds.length ||
        drafts.some((d) => d.anchor.commit !== action.headSha)
      )
        throw new ForgeError("conflict");
      // Validate every selected coordinate against the hosted patch, never a local worktree.
      const files = await this.#records(
        `${this.#root}/pulls/${number}/files?per_page=100`,
        z.looseObject({ filename: text, patch: z.string().max(4_194_304).optional() }),
        signal,
      );
      for (const draft of drafts) {
        const patch = files.find((f) => f.filename === draft.anchor.path)?.patch;
        if (!patch || !validHostedAnchor(patch, draft.anchor)) throw new ForgeError("conflict");
      }
      const latest = await this.host(number, signal);
      if (latest.pr.headRefOid !== action.headSha || latest.pr.state !== "OPEN")
        throw new ForgeError("conflict");
      if (!allowed()) throw new ForgeError("cancelled");
      dispatch();
      const response = await this.#api.request(`${this.#root}/pulls/${number}/reviews`, signal, {
        commit_id: action.headSha,
        event: action.event,
        body: `${action.body}\n\n${marker}`,
        comments: drafts.map((d) => ({
          path: d.anchor.path,
          line: d.anchor.line,
          side: d.anchor.side,
          ...(d.anchor.startLine === undefined
            ? {}
            : { start_line: d.anchor.startLine, start_side: d.anchor.startSide ?? d.anchor.side }),
          body: d.body,
        })),
      });
      const review = decode(Review, response.body);
      if (review.state === "PENDING" || review.commit_id !== action.headSha)
        throw new ForgeError("invalid_data");
      return;
    }
    if (action.kind === "conversation" || action.kind === "reply") {
      if (!host.pr.viewerCanComment) throw new ForgeError("forbidden");
      if (
        action.kind === "reply" &&
        !(await this.#comment(number, "inline", action.commentId, signal))
      )
        throw new ForgeError("not_found");
      if (!allowed()) throw new ForgeError("cancelled");
      const path =
        action.kind === "reply"
          ? `pulls/${number}/comments/${action.commentId}/replies`
          : `issues/${number}/comments`;
      dispatch();
      decode(
        Comment,
        (
          await this.#api.request(`${this.#root}/${path}`, signal, {
            body: `${action.body}\n\n${marker}`,
          })
        ).body,
      );
      return;
    }
    if (action.kind === "comment.edit" || action.kind === "comment.delete") {
      const c = await this.#comment(number, action.source, action.commentId, signal);
      if (!c || c.user?.login !== host.viewer) throw new ForgeError("forbidden");
      if (c.body !== action.expectedBody) throw new ForgeError("conflict");
      if (!allowed()) throw new ForgeError("cancelled");
      const path = `${this.#root}/${action.source === "inline" ? "pulls" : "issues"}/comments/${action.commentId}`;
      dispatch();
      await this.#api.request(
        path,
        signal,
        action.kind === "comment.edit" ? { body: action.body } : undefined,
        action.kind === "comment.edit" ? "PATCH" : "DELETE",
      );
      return;
    }
    if (action.kind === "thread.resolve" || action.kind === "thread.unresolve") {
      const t = host.threads.find((entry) => entry.id === action.threadId);
      if (!t || !(action.kind === "thread.resolve" ? t.viewerCanResolve : t.viewerCanUnresolve))
        throw new ForgeError("forbidden");
      dispatch();
      await this.#mutation(
        action.kind === "thread.resolve" ? "resolveReviewThread" : "unresolveReviewThread",
        { threadId: t.id, clientMutationId: operationId },
        signal,
      );
      return;
    }
    if (action.kind === "file.view" || action.kind === "file.unview") {
      if (host.pr.headRefOid !== action.headSha) throw new ForgeError("conflict");
      if (!(await this.viewed(number, action.headSha, signal)).some((f) => f.path === action.path))
        throw new ForgeError("not_found");
      if (!allowed()) throw new ForgeError("cancelled");
      dispatch();
      await this.#mutation(
        action.kind === "file.view" ? "markFileAsViewed" : "unmarkFileAsViewed",
        { pullRequestId: host.pr.id, path: action.path, clientMutationId: operationId },
        signal,
      );
    }
  }
}
