import type { ForgePrStatus, ForgeRepository } from "@ace/protocol/forge";
import type { z } from "zod";
import type { StatusRevisions } from "./revisions.ts";
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

type SourceThread = z.infer<
  typeof ReviewThreadsPage
>["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][number];
type Thread = ForgePrStatus["reviewThreads"][number];
type Projection = { source: SourceThread; versions: string[]; row: Thread };
function sameThread(a: SourceThread, b: SourceThread): boolean {
  return (
    a.id === b.id &&
    a.path === b.path &&
    a.line === b.line &&
    a.isResolved === b.isResolved &&
    a.isOutdated === b.isOutdated &&
    a.comments.nodes.length === b.comments.nodes.length &&
    a.comments.nodes.every((item, index) => {
      const previous = b.comments.nodes[index];
      return (
        previous?.databaseId === item.databaseId &&
        previous.body === item.body &&
        previous.updatedAt === item.updatedAt &&
        previous.author?.login === item.author?.login
      );
    })
  );
}
/** Bounded query plan avoids traversing every thread on unchanged GraphQL polls. */
export class ReviewThreadReader {
  readonly #threads = new PageDecoder(ReviewThreadsPage);
  readonly #comments = new PageDecoder(ReviewCommentConnection);
  readonly #versions: StatusRevisions["threads"];
  #projections = new Map<string, Projection>();
  constructor(revisions: StatusRevisions) {
    this.#versions = revisions.threads;
  }
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
    const projections = new Map<string, Projection>();
    const upsert: Thread[] = [];
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
        const connections = [thread.comments.nodes];
        const versions: string[] = [];
        commentCount += thread.comments.nodes.length;
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
          connections.push(replies.nodes);
          versions.push(next.version);
          if (replies.pageInfo.hasNextPage && replies.pageInfo.endCursor === info.endCursor)
            throw new ForgeError("invalid_data");
          info = replies.pageInfo;
        }
        if (info.hasNextPage) throw new ForgeError("limit");
        const knownProjection = this.#projections.get(thread.id);
        const unchanged =
          knownProjection &&
          sameThread(knownProjection.source, thread) &&
          versions.length === knownProjection.versions.length &&
          versions.every((version, index) => version === knownProjection.versions[index]);
        const row: Thread = unchanged
          ? knownProjection.row
          : immutable({
              id: thread.id,
              resolved: thread.isResolved,
              outdated: thread.isOutdated,
              file: thread.path,
              line: thread.line,
              comments: connections.flat().map((comment) => ({
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
        result.push(row);
        projections.set(thread.id, { source: thread, versions, row });
        if (row !== knownProjection?.row) upsert.push(row);
      }
      more = connection.pageInfo.hasNextPage;
      if (more && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor))
        throw new ForgeError("invalid_data");
      cursor = connection.pageInfo.endCursor;
      if (result.length > 2_000) throw new ForgeError("limit");
    }
    if (more) throw new ForgeError("limit");
    const removed: Thread[] = [];
    for (const [id, projection] of this.#projections)
      if (!projections.has(id)) removed.push(projection.row);
    this.#projections = projections;
    const items = this.#versions.retain(this.#last?.threads ?? [], result, { upsert, removed });
    this.#number = number;
    this.#plan = plan;
    this.#last = immutable({ threads: items, raw: plan.map((entry) => entry.page.body) });
    return this.#last;
  }
}
