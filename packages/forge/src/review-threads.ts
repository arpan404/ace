import type { ForgePrStatus, ForgeRepository } from "@ace/protocol/forge";
import type { GhApi, Page } from "./http.ts";
import type { ReadBudget } from "./read-budget.ts";
import { PageDecoder } from "./resource.ts";
import { immutable } from "./immutable.ts";
import { ReviewThreadsPage, ReviewCommentConnection } from "./github-schemas.ts";
import { ForgeError } from "./errors.ts";

const pageFields = `pageInfo { hasNextPage endCursor } nodes { databaseId body updatedAt author { login } }`;
const threadsQuery = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:100){${pageFields}}}}}}}`;
const commentsQuery = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){${pageFields}}}}}`;
type Query = { query: string; variables: Record<string, string | number | null> };
type Planned = { key: string; query: Query; page: Page };
type ReviewResource = { threads: ForgePrStatus["reviewThreads"]; raw: unknown[] };

/** Bounded query plan avoids traversing every thread on unchanged GraphQL polls. */
export class ReviewThreadReader {
  readonly #threads = new PageDecoder(ReviewThreadsPage);
  readonly #comments = new PageDecoder(ReviewCommentConnection);
  #plan: Planned[] = [];
  #number: number | undefined;
  #last: ReviewResource | undefined;
  async read(
    api: GhApi,
    repository: ForgeRepository,
    number: number,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<ReviewResource> {
    const memo = new Map<string, Page>();
    const fetch = async (key: string, query: Query): Promise<Page> => {
      const known = memo.get(key);
      if (known) return known;
      if (memo.size >= 64) throw new ForgeError("limit");
      const page = await api.request("graphql", signal, query);
      budget.add(page.bytes);
      memo.set(key, page);
      return page;
    };
    const previous = this.#last;
    const previousPlan = this.#plan;
    if (previous && this.#number === number) {
      let unchanged = true;
      for (const request of previousPlan) {
        const page = await fetch(request.key, request.query);
        if (page !== request.page) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return previous;
    }
    const plan: Planned[] = [];
    const request = async (query: Query) => {
      const key = JSON.stringify(query);
      const page = await fetch(key, query);
      plan.push({ key, query, page });
      return page;
    };
    const result: ForgePrStatus["reviewThreads"] = [];
    let commentCount = 0;
    let cursor: string | null = null;
    let more = true;
    for (let page = 0; more && page < 20; page++) {
      const response = await request({
        query: threadsQuery,
        variables: { owner: repository.owner, name: repository.name, number, cursor },
      });
      const connection = this.#threads.read(response).data.repository.pullRequest.reviewThreads;
      for (const thread of connection.nodes) {
        const comments = [...thread.comments.nodes];
        commentCount += comments.length;
        if (commentCount > 2_000) throw new ForgeError("limit");
        let info = thread.comments.pageInfo;
        for (let count = 1; info.hasNextPage && count < 20; count++) {
          if (!info.endCursor) throw new ForgeError("invalid_data");
          const next = await request({
            query: commentsQuery,
            variables: { id: thread.id, cursor: info.endCursor },
          });
          const replies = this.#comments.read(next).data.node.comments;
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
    this.#number = number;
    this.#plan = plan;
    this.#last = immutable({ threads: result, raw: plan.map((entry) => entry.page.body) });
    return this.#last;
  }
}
