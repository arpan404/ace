import { z } from "zod";
import type { ForgePrRef } from "@ace/protocol/forge";
import type {
  ForgeReactionContent,
  ForgeReactionSubject,
  ForgeReactionSummary,
  ForgeReviewAction,
} from "@ace/protocol/forge-review";
import type { WriteDispatch } from "./write-dispatch.ts";
import { ForgeError } from "./errors.ts";
import { ReadBudget } from "./read-budget.ts";
import { decode, type ReviewIo } from "./review-io.ts";

type ReactionAction = Extract<ForgeReviewAction, { kind: "reaction.add" | "reaction.remove" }>;
const text = z.string().max(65_536);
const fromGraphql: Record<string, ForgeReactionContent> = {
  THUMBS_UP: "+1",
  THUMBS_DOWN: "-1",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};
const groupFields = "reactionGroups { content viewerHasReacted reactors { totalCount } }";
// Reaction kinds GitHub adds later are kept out rather than failing the read.
const Groups = z
  .array(
    z.object({
      content: text,
      viewerHasReacted: z.boolean(),
      reactors: z.object({ totalCount: z.number().int().nonnegative() }),
    }),
  )
  .max(32)
  .nullable();
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: text.nullable() });
const Commented = z.object({ databaseId: z.number().int().positive(), reactionGroups: Groups });
const Conversation = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reactionGroups: Groups,
        comments: z.object({ nodes: z.array(Commented.nullable()).max(100), pageInfo: PageInfo }),
      }),
    }),
  }),
});
const Threads = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z
            .array(
              z.object({ comments: z.object({ nodes: z.array(Commented.nullable()).max(100) }) }),
            )
            .max(50),
          pageInfo: PageInfo,
        }),
      }),
    }),
  }),
});
const Reaction = z.looseObject({
  id: z.number().int().positive(),
  content: text,
  user: z.looseObject({ login: text }).nullable(),
});
const conversationQuery = `query PrReactions($owner:String!,$name:String!,$number:Int!,$after:String){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ ${groupFields} comments(first:100,after:$after){ nodes { databaseId ${groupFields} } pageInfo { hasNextPage endCursor } } } } }`;
const threadsQuery = `query PrReviewReactions($owner:String!,$name:String!,$number:Int!,$after:String){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reviewThreads(first:50,after:$after){ nodes { comments(first:100){ nodes { databaseId ${groupFields} } } } pageInfo { hasNextPage endCursor } } } } }`;

function summary(
  subject: ForgeReactionSubject,
  groups: z.infer<typeof Groups>,
): ForgeReactionSummary | undefined {
  const kept = (groups ?? []).flatMap((group) => {
    const content = fromGraphql[group.content];
    const count = group.reactors.totalCount;
    return content && (count > 0 || group.viewerHasReacted)
      ? [{ content, count, viewer: group.viewerHasReacted }]
      : [];
  });
  return kept.length ? { subject, groups: kept } : undefined;
}

/** Reactions on the PR description and its comments: who reacted how, and the viewer's own. */
export class GitHubReactions {
  readonly #io: ReviewIo;
  readonly #pr: (number: number) => ForgePrRef;
  constructor(io: ReviewIo, pr: (number: number) => ForgePrRef) {
    this.#io = io;
    this.#pr = pr;
  }
  /** Every reacted subject of the PR. Bounded: 3,000 conversation comments, 1,000 threads. */
  async summaries(number: number, signal: AbortSignal): Promise<ForgeReactionSummary[]> {
    const { owner, name } = this.#pr(number).repository;
    const budget = new ReadBudget();
    const result: ForgeReactionSummary[] = [];
    const push = (item: ForgeReactionSummary | undefined) => item && result.push(item);
    const page = async <T>(
      query: string,
      schema: z.ZodType<T>,
      connection: (data: T) => z.infer<typeof PageInfo>,
      take: (data: T, first: boolean) => void,
      limit: number,
    ) => {
      let after: string | null = null;
      for (let count = 0; count < limit; count++) {
        const response = await this.#io.request("graphql", signal, {
          query,
          variables: { owner, name, number, after },
        });
        budget.add(response.bytes);
        const data = decode(schema, response.body);
        take(data, count === 0);
        const info = connection(data);
        if (!info.hasNextPage) return;
        if (!info.endCursor || info.endCursor === after) throw new ForgeError("invalid_data");
        after = info.endCursor;
      }
      throw new ForgeError("limit");
    };
    await page(
      conversationQuery,
      Conversation,
      (data) => data.data.repository.pullRequest.comments.pageInfo,
      (data, first) => {
        const pr = data.data.repository.pullRequest;
        if (first) push(summary({ kind: "pr" }, pr.reactionGroups));
        for (const node of pr.comments.nodes)
          if (node)
            push(summary({ kind: "issue", commentId: node.databaseId }, node.reactionGroups));
      },
      30,
    );
    await page(
      threadsQuery,
      Threads,
      (data) => data.data.repository.pullRequest.reviewThreads.pageInfo,
      (data) => {
        for (const thread of data.data.repository.pullRequest.reviewThreads.nodes)
          for (const node of thread.comments.nodes)
            if (node)
              push(summary({ kind: "inline", commentId: node.databaseId }, node.reactionGroups));
      },
      20,
    );
    if (result.length > 4_001) throw new ForgeError("limit");
    return result;
  }
  #path(number: number, subject: ForgeReactionSubject): string {
    const root = this.#io.root;
    if (subject.kind === "pr") return `${root}/issues/${number}/reactions`;
    return subject.kind === "issue"
      ? `${root}/issues/comments/${subject.commentId}/reactions`
      : `${root}/pulls/comments/${subject.commentId}/reactions`;
  }
  /** The viewer's reaction of this kind on the subject, if they have one. */
  async #own(
    number: number,
    action: ReactionAction,
    viewer: string,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const reactions = await this.#io.records(
      `${this.#path(number, action.subject)}?content=${encodeURIComponent(action.content)}&per_page=100`,
      Reaction,
      signal,
    );
    return reactions.find((r) => r.content === action.content && r.user?.login === viewer)?.id;
  }
  async write(
    number: number,
    action: ReactionAction,
    viewer: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<void> {
    // A comment id is only ever reacted to as one of this PR's own comments.
    if (
      action.subject.kind !== "pr" &&
      !(await this.#io.comment(number, action.subject.kind, action.subject.commentId, signal))
    )
      throw new ForgeError("not_found", undefined, false);
    const path = this.#path(number, action.subject);
    if (action.kind === "reaction.add") {
      if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
      // GitHub answers an existing reaction with that same reaction, so adding is idempotent.
      decode(
        Reaction,
        (await this.#io.request(path, signal, { content: action.content }, "POST", dispatch)).body,
      );
      return;
    }
    const own = await this.#own(number, action, viewer, signal);
    if (own === undefined) return;
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    await this.#io.request(`${path}/${own}`, signal, undefined, "DELETE", dispatch);
  }
  async reconcile(
    number: number,
    action: ReactionAction,
    viewer: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const own = await this.#own(number, action, viewer, signal);
    return (own !== undefined) === (action.kind === "reaction.add");
  }
}
