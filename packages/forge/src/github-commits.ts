import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { ForgeCommit } from "@ace/protocol/forge-browser";
import { ForgeError } from "./errors.ts";
import { CommitRecord } from "./github-browser-schemas.ts";
import type { GhApi } from "./http.ts";

/** Commits per read: the largest page GraphQL and the comparison API give. */
const pageSize = 100;
/** GitHub lists a pull request's newest 250 commits, through REST and GraphQL alike. */
const listedCommits = 250;
/** Pages read while proving a commit belongs to a pull request: its newest 10,000 commits. */
const membershipPages = 100;
const Sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const text = z.string().max(1_048_576);
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
const ListedPage = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: Sha,
        baseRefOid: Sha,
        commits: z.object({
          totalCount: z.number().int().nonnegative(),
          pageInfo: z.object({
            hasPreviousPage: z.boolean(),
            startCursor: z.string().min(1).max(200).nullable(),
          }),
          nodes: z.array(z.unknown()).max(pageSize),
        }),
      }),
    }),
  }),
});
const ComparedPage = z.looseObject({
  total_commits: z.number().int().nonnegative(),
  commits: z.array(CommitRecord).max(pageSize),
});
const Statistics = z.object({
  data: z.object({
    repository: z.record(
      z.string(),
      z
        .looseObject({
          oid: Sha,
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
        })
        .nullable(),
    ),
  }),
});

// `last`/`before` walk the listed commits from the newest back.
const listedQuery = `query PrCommits($owner:String!, $name:String!, $number:Int!, $before:String) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { headRefOid baseRefOid commits(last:${pageSize}, before:$before) { totalCount pageInfo { hasPreviousPage startCursor } nodes { commit { oid message url additions deletions author { name date user { login avatarUrl } } } } } } } }`;
/**
 * Where the commits older than the listed 250 continue: a page of the comparison of the base
 * with the head, which lists every commit, oldest first; only its first `older` are unlisted.
 */
const compareCursor = /^compare:([1-9]\d{0,3}):([1-9]\d{0,5}):([a-fA-F0-9]{40,64})$/;

export type CommitPage = {
  /** Oldest first, as GitHub lists them. */
  commits: ForgeCommit[];
  /** Read the next older page by passing this as `before`. */
  before?: string;
  /**
   * Pages older than every page `before` leads to, newest first. Each is read on its own, so
   * they can be read side by side; only the newest page names them.
   */
  alongside?: string[];
  total: number;
};

const slice = (value: string) => value.slice(0, 65_536);

function listedCommit(record: unknown): ForgeCommit {
  const parsed = Node.safeParse(record);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const value = parsed.data.commit;
  return {
    raw: record,
    sha: value.oid,
    message: slice(value.message),
    author: slice(value.author?.user?.login ?? value.author?.name ?? "deleted user"),
    ...(value.author?.user?.avatarUrl
      ? { authorAvatarUrl: slice(value.author.user.avatarUrl) }
      : {}),
    ...(typeof value.additions === "number" ? { additions: value.additions } : {}),
    ...(typeof value.deletions === "number" ? { deletions: value.deletions } : {}),
    date: value.author?.date ? slice(value.author.date) : null,
    url: slice(value.url),
  };
}

/**
 * One page of a pull request's commits, newest page first, proven to belong to `headSha`. The
 * newest 250 come from GraphQL with their statistics; older ones from the comparison of the
 * pull request's base with its head, which GitHub does not cap.
 */
export async function readCommitPage(
  api: GhApi,
  repository: ForgeRepository,
  input: { number: number; before?: string | undefined; headSha: string },
  signal: AbortSignal,
): Promise<CommitPage> {
  const compared = input.before === undefined ? null : compareCursor.exec(input.before);
  if (compared) {
    const [, page = "", older = "", base = ""] = compared;
    return readComparedPage(api, repository, input.headSha, signal, {
      page: Number(page),
      older: Number(older),
      base,
    });
  }
  const response = await api.request("graphql", signal, {
    query: listedQuery,
    variables: {
      owner: repository.owner,
      name: repository.name,
      number: input.number,
      before: input.before ?? null,
    },
  });
  const parsed = ListedPage.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const pr = parsed.data.data.repository.pullRequest;
  if (pr.headRefOid.toLowerCase() !== input.headSha.toLowerCase()) throw new ForgeError("conflict");
  const { pageInfo, totalCount } = pr.commits;
  const older = totalCount - listedCommits;
  // The unlisted pages are known from the newest page, so they are named there, all at once.
  const alongside =
    input.before === undefined && older > 0
      ? Array.from(
          { length: Math.ceil(older / pageSize) },
          (_, i) => `compare:${Math.ceil(older / pageSize) - i}:${older}:${pr.baseRefOid}`,
        )
      : [];
  return {
    commits: pr.commits.nodes.map(listedCommit),
    ...(pageInfo.hasPreviousPage && pageInfo.startCursor ? { before: pageInfo.startCursor } : {}),
    ...(alongside.length ? { alongside } : {}),
    total: totalCount,
  };
}

async function readComparedPage(
  api: GhApi,
  repository: ForgeRepository,
  headSha: string,
  signal: AbortSignal,
  at: { page: number; older: number; base: string },
): Promise<CommitPage> {
  if (at.page > Math.ceil(at.older / pageSize)) throw new ForgeError("invalid_data");
  const path = `repos/${repository.owner}/${repository.name}/compare/${at.base}...${headSha}?per_page=${pageSize}&page=${at.page}`;
  const parsed = ComparedPage.safeParse((await api.request(path, signal)).body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  // Another count means the base or head moved since the listed commits were read.
  if (parsed.data.total_commits !== at.older + listedCommits) throw new ForgeError("conflict");
  const first = (at.page - 1) * pageSize;
  const records = parsed.data.commits.slice(0, Math.max(0, at.older - first));
  const commits: ForgeCommit[] = records.map((item) => ({
    raw: item,
    sha: item.sha,
    message: item.commit.message,
    author: item.author?.login ?? item.commit.author?.name ?? "deleted user",
    authorAvatarUrl: item.author?.avatar_url,
    date: item.commit.author?.date ?? null,
    url: item.html_url,
  }));
  const stats = await statistics(api, repository, commits, signal);
  commits.forEach((commit, i) => {
    const stat = stats?.[`c${i}`];
    if (stat?.oid !== commit.sha) return;
    commit.additions = stat.additions;
    commit.deletions = stat.deletions;
  });
  return { commits, total: parsed.data.total_commits };
}

/** One bounded GraphQL batch supplies statistics the comparison's commits lack. */
async function statistics(
  api: GhApi,
  repository: ForgeRepository,
  commits: readonly ForgeCommit[],
  signal: AbortSignal,
) {
  if (!commits.length) return undefined;
  const fields = commits.map(
    (c, i) =>
      `c${i}: object(oid: ${JSON.stringify(c.sha)}) { ... on Commit { oid additions deletions } }`,
  );
  const parsed = Statistics.safeParse(
    (
      await api.request("graphql", signal, {
        query: `query { repository(owner:${JSON.stringify(repository.owner)}, name:${JSON.stringify(repository.name)}) { ${fields.join(" ")} } }`,
      })
    ).body,
  );
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data.data.repository;
}

/** Whether `sha` is one of the pull request's commits, read newest first until it is found. */
export async function prHasCommit(
  api: GhApi,
  repository: ForgeRepository,
  input: { number: number; headSha: string; sha: string },
  signal: AbortSignal,
): Promise<boolean> {
  const pages: (string | undefined)[] = [undefined];
  for (let read = 0; read < membershipPages && pages.length; read++) {
    const page = await readCommitPage(api, repository, { ...input, before: pages.shift() }, signal);
    if (page.commits.some((c) => c.sha.toLowerCase() === input.sha.toLowerCase())) return true;
    // The listed pages first, newest first, then the older ones.
    pages.unshift(...(page.before ? [page.before] : []));
    pages.push(...(page.alongside ?? []));
  }
  return false;
}
