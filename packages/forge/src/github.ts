import { z } from "zod";
import {
  ForgeRepository,
  ForgePrRef,
  ForgeCreatePrInput,
  ForgePrStatus,
} from "@ace/protocol/forge";
import type { Forge, MergeMethod } from "./api.ts";
import { ReadBudget } from "./read-budget.ts";
import { GhApi } from "./http.ts";
import {
  CheckPage,
  CommentPage,
  GitHubPr,
  StatusPage,
  ReviewThreadsPage,
  ReviewCommentConnection,
} from "./github-schemas.ts";
import { mapPr, mapCheck, mapComment, mapIssueComment, mapLegacyStatus } from "./status.ts";
import { ForgeError } from "./errors.ts";
import type { CommandRunner } from "./command.ts";

const positive = z.number().int().positive();
const shaSchema = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const mergeSchema = z.enum(["merge", "squash", "rebase"]);
const pageFields = `pageInfo { hasNextPage endCursor } nodes { databaseId body updatedAt author { login } }`;
const threadsQuery = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:100){${pageFields}}}}}}}`;
const commentsQuery = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){${pageFields}}}}}`;

export class GitHubForge implements Forge {
  readonly repository: ForgeRepository;
  readonly #api: GhApi;
  readonly #root: string;
  constructor(options: {
    repository: ForgeRepository;
    runner: CommandRunner;
    command?: string;
    now: () => number;
  }) {
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "github" || this.repository.owner.includes("/"))
      throw new ForgeError("unsupported");
    this.#root = `repos/${this.repository.owner}/${this.repository.name}`;
    this.#api = new GhApi({ ...options, host: this.repository.host });
  }
  #ref(number: number): ForgePrRef {
    return ForgePrRef.parse({ repository: this.repository, number });
  }
  async status(number: number, signal: AbortSignal): Promise<ForgePrStatus> {
    const budget = new ReadBudget();
    const ref = this.#ref(number);
    const response = await this.#api.request(`${this.#root}/pulls/${ref.number}`, signal);
    budget.add(response.bytes);
    const pr = GitHubPr.safeParse(response.body);
    if (!pr.success || pr.data.number !== number) throw new ForgeError("invalid_data");
    const sha = pr.data.head.sha;
    // Serial calls avoid secondary rate limits; each resource has its own ETag.
    const checks = await this.#api.list(
      `${this.#root}/commits/${sha}/check-runs?per_page=100&filter=latest`,
      CheckPage,
      signal,
      budget,
    );
    const statuses = await this.#api.list(
      `${this.#root}/commits/${sha}/statuses?per_page=100`,
      StatusPage,
      signal,
      budget,
    );
    const latest = new Map<string, z.infer<typeof StatusPage>[number]>();
    for (const status of statuses)
      if (!latest.has(status.context)) latest.set(status.context, status);
    const result = mapPr(ref, pr.data, [
      ...checks.map(mapCheck),
      ...[...latest.values()].map(mapLegacyStatus),
    ]);
    const reviewComments = await this.#api.list(
      `${this.#root}/pulls/${number}/comments?per_page=100`,
      CommentPage,
      signal,
      budget,
    );
    const issueComments = await this.#api.list(
      `${this.#root}/issues/${number}/comments?per_page=100`,
      CommentPage,
      signal,
      budget,
    );
    result.comments = [...reviewComments.map(mapComment), ...issueComments.map(mapIssueComment)];
    const review = await this.#reviewThreads(number, signal, budget);
    result.raw = {
      pr: response.body,
      checks,
      statuses,
      reviewComments,
      issueComments,
      reviewThreads: review.raw,
    };
    result.reviewThreads = review.threads;
    return ForgePrStatus.parse(result);
  }
  async #reviewThreads(
    number: number,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<{ threads: ForgePrStatus["reviewThreads"]; raw: unknown[] }> {
    const result: ForgePrStatus["reviewThreads"] = [];
    const raw: unknown[] = [];
    let commentCount = 0;
    let cursor: string | null = null;
    let more = true;
    for (let page = 0; more && page < 20; page++) {
      const response = await this.#api.request("graphql", signal, {
        query: threadsQuery,
        variables: { owner: this.repository.owner, name: this.repository.name, number, cursor },
      });
      budget.add(response.bytes);
      raw.push(response.body);
      const parsed = ReviewThreadsPage.safeParse(response.body);
      if (!parsed.success) throw new ForgeError("invalid_data");
      const connection = parsed.data.data.repository.pullRequest.reviewThreads;
      for (const thread of connection.nodes) {
        const comments = [...thread.comments.nodes];
        commentCount += comments.length;
        if (commentCount > 2_000) throw new ForgeError("limit");
        let info = thread.comments.pageInfo;
        for (let count = 1; info.hasNextPage && count < 20; count++) {
          if (!info.endCursor) throw new ForgeError("invalid_data");
          const next = await this.#api.request("graphql", signal, {
            query: commentsQuery,
            variables: { id: thread.id, cursor: info.endCursor },
          });
          budget.add(next.bytes);
          raw.push(next.body);
          const decoded = ReviewCommentConnection.safeParse(next.body);
          if (!decoded.success) throw new ForgeError("invalid_data");
          const replies = decoded.data.data.node.comments;
          commentCount += replies.nodes.length;
          if (commentCount > 2_000) throw new ForgeError("limit");
          comments.push(...replies.nodes);
          if (replies.pageInfo.hasNextPage && replies.pageInfo.endCursor === info.endCursor)
            throw new ForgeError("invalid_data");
          info = replies.pageInfo;
        }
        if (info.hasNextPage) throw new ForgeError("limit");
        result.push({
          id: thread.id,
          resolved: thread.isResolved,
          outdated: thread.isOutdated,
          file: thread.path,
          line: thread.line,
          comments: comments.map((comment) => ({
            kind: "inline",
            id: comment.databaseId,
            body: comment.body,
            author: comment.author?.login ?? "ghost",
            file: thread.path,
            line: thread.line,
            updatedAt: comment.updatedAt,
            replyTo: null,
          })),
        });
      }
      more = connection.pageInfo.hasNextPage;
      if (more && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor))
        throw new ForgeError("invalid_data");
      cursor = connection.pageInfo.endCursor;
      if (result.length > 2_000) throw new ForgeError("limit");
    }
    if (more) throw new ForgeError("limit");
    return { threads: result, raw };
  }
  async createPr(
    threadId: string,
    input: ForgeCreatePrInput,
    signal: AbortSignal,
  ): Promise<ForgePrRef> {
    const value = ForgeCreatePrInput.parse(input);
    const fields: Record<string, string> = {
      threadId: z.string().min(1).max(256).parse(threadId),
      branch: value.branch,
      title: value.title,
      summary: value.summary,
    };
    const render = (template: string) =>
      template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const field = fields[key];
        if (!Object.hasOwn(fields, key) || field === undefined)
          throw new ForgeError("invalid_data");
        return field;
      });
    const title = z.string().min(1).max(256).parse(render(value.template.title));
    const body = z.string().max(65_536).parse(render(value.template.body));
    const response = await this.#api.request(`${this.#root}/pulls`, signal, {
      head: value.branch,
      base: value.base,
      title,
      body,
      draft: value.draft,
    });
    const parsed = GitHubPr.safeParse(response.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    return this.#ref(parsed.data.number);
  }
  async replyComment(
    number: number,
    commentId: number,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ref(number);
    positive.parse(commentId);
    z.string().min(1).max(65_536).parse(body);
    const response = await this.#api.request(
      `${this.#root}/pulls/${number}/comments/${commentId}/replies`,
      signal,
      { body },
    );
    if (!z.object({ id: positive }).safeParse(response.body).success)
      throw new ForgeError("invalid_data");
  }
  async requestReviews(number: number, reviewers: string[], signal: AbortSignal): Promise<void> {
    this.#ref(number);
    const names = z
      .array(z.string().regex(/^[\w-]+$/))
      .min(1)
      .max(100)
      .parse(reviewers);
    const response = await this.#api.request(
      `${this.#root}/pulls/${number}/requested_reviewers`,
      signal,
      { reviewers: names },
    );
    if (
      !z
        .object({ requested_reviewers: z.array(z.object({ login: z.string() })).max(100) })
        .safeParse(response.body).success
    )
      throw new ForgeError("invalid_data");
  }
  async merge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ref(number);
    shaSchema.parse(headSha);
    mergeSchema.parse(method);
    const response = await this.#api.request(
      `${this.#root}/pulls/${number}/merge`,
      signal,
      { sha: headSha, merge_method: method },
      "PUT",
    );
    const parsed = z.object({ merged: z.boolean() }).safeParse(response.body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    if (!parsed.data.merged) throw new ForgeError("conflict");
  }
  async enableAutoMerge(
    number: number,
    headSha: string,
    method: MergeMethod,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ref(number);
    shaSchema.parse(headSha);
    mergeSchema.parse(method);
    await this.#api.autoMerge(
      `${this.repository.host}/${this.repository.owner}/${this.repository.name}`,
      number,
      headSha,
      method,
      signal,
    );
  }
  async logTail(jobId: number, signal: AbortSignal) {
    positive.parse(jobId);
    return this.#api.log(`${this.#root}/actions/jobs/${jobId}/logs`, signal);
  }
}
