import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { ForgeCommit } from "@ace/protocol/forge-browser";
import { ForgeError } from "./errors.ts";
import type { GhApi } from "./http.ts";

/** Commits per read: GraphQL's largest page. */
export const commitPageSize = 100;
/** Pages read while proving a commit belongs to a pull request: its newest 10,000 commits. */
const membershipPages = 100;
const Sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const text = z.string().max(1_048_576);
const cursor = z.string().min(1).max(256);
const Node = z.looseObject({
  commit: z.looseObject({
    oid: Sha,
    message: text,
    url: text,
    additions: z.number().int().nonnegative().nullable().optional(),
    deletions: z.number().int().nonnegative().nullable().optional(),
    author: z
      .looseObject({
        name: text.nullable().optional(),
        date: text.nullable().optional(),
        user: z
          .looseObject({ login: text, avatarUrl: text.nullable().optional() })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  }),
});
const CommitPage = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: Sha,
        commits: z.object({
          totalCount: z.number().int().nonnegative(),
          pageInfo: z.object({
            hasPreviousPage: z.boolean(),
            startCursor: cursor.nullable(),
          }),
          nodes: z.array(z.unknown()).max(commitPageSize),
        }),
      }),
    }),
  }),
});

// `last`/`before` walk the list from its newest commit back. REST stops at 250 commits;
// this connection lists them all.
const query = `query PrCommits($owner:String!, $name:String!, $number:Int!, $before:String) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { headRefOid commits(last:${commitPageSize}, before:$before) { totalCount pageInfo { hasPreviousPage startCursor } nodes { commit { oid message url additions deletions author { name date user { login avatarUrl } } } } } } } }`;

export type CommitPage = {
  /** Oldest first, as GitHub lists them. */
  commits: ForgeCommit[];
  /** Read the next older page by passing this as `before`. */
  before?: string;
  total: number;
  headSha: string;
};

function commit(record: unknown): ForgeCommit {
  const parsed = Node.safeParse(record);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const value = parsed.data.commit;
  return {
    raw: record,
    sha: value.oid,
    message: value.message.slice(0, 65_536),
    author: (value.author?.user?.login ?? value.author?.name ?? "deleted user").slice(0, 65_536),
    ...(value.author?.user?.avatarUrl
      ? { authorAvatarUrl: value.author.user.avatarUrl.slice(0, 65_536) }
      : {}),
    ...(typeof value.additions === "number" ? { additions: value.additions } : {}),
    ...(typeof value.deletions === "number" ? { deletions: value.deletions } : {}),
    date: value.author?.date?.slice(0, 65_536) ?? null,
    url: value.url.slice(0, 65_536),
  };
}

/**
 * One page of a pull request's commits, newest page first. Statistics and the head the list
 * belongs to come in the same answer, so a push can never mix two heads' commits in a page.
 */
export async function readCommitPage(
  api: GhApi,
  repository: ForgeRepository,
  input: { number: number; before?: string | undefined },
  signal: AbortSignal,
): Promise<CommitPage> {
  const response = await api.request("graphql", signal, {
    query,
    variables: {
      owner: repository.owner,
      name: repository.name,
      number: input.number,
      before: input.before ?? null,
    },
  });
  const parsed = CommitPage.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const pr = parsed.data.data.repository.pullRequest;
  const { pageInfo } = pr.commits;
  return {
    commits: pr.commits.nodes.map(commit),
    ...(pageInfo.hasPreviousPage && pageInfo.startCursor ? { before: pageInfo.startCursor } : {}),
    total: pr.commits.totalCount,
    headSha: pr.headRefOid,
  };
}

/** Whether `sha` is one of the pull request's commits, read newest first until it is found. */
export async function prHasCommit(
  api: GhApi,
  repository: ForgeRepository,
  number: number,
  sha: string,
  signal: AbortSignal,
): Promise<boolean> {
  let before: string | undefined;
  for (let page = 0; page < membershipPages; page++) {
    const read = await readCommitPage(api, repository, { number, before }, signal);
    if (read.commits.some((c) => c.sha.toLowerCase() === sha.toLowerCase())) return true;
    if (!read.before) return false;
    before = read.before;
  }
  return false;
}
