import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import type {
  ForgePerson,
  ForgePrReviewers,
  ForgeReference,
  ForgeRequestedReviewer,
} from "@ace/protocol/forge-people";
import type { GhApi } from "./http.ts";
import { decode } from "./review-io.ts";

const text = z.string().max(65_536);
const login = z.string().min(1).max(100);
const Person = z.looseObject({
  login,
  name: z.string().max(256).nullable().optional(),
  avatarUrl: text.nullable().optional(),
});
const People = z.object({
  data: z.object({
    repository: z.object({
      mentionableUsers: z.object({ nodes: z.array(Person.nullable()).max(100) }),
    }),
  }),
});
// Search can return other kinds of node (discussions); those have no `number` and are skipped.
const Found = z.looseObject({
  __typename: text.optional(),
  number: z.number().int().positive().optional(),
  title: text.optional(),
  state: text.optional(),
  isDraft: z.boolean().optional(),
});
const Search = z.object({ nodes: z.array(Found.nullable()).max(100) });
const References = z.object({
  data: z.object({
    open: Search,
    recent: Search,
    repository: z.object({ issueOrPullRequest: Found.nullable().optional() }).nullable(),
  }),
});
const Requested = z.looseObject({
  __typename: text,
  login: login.optional(),
  avatarUrl: text.nullable().optional(),
  slug: login.optional(),
  name: z.string().max(256).nullable().optional(),
});
const ReviewStates = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
] as const;
const Reviewers = z.object({
  data: z.object({
    repository: z.object({
      viewerPermission: text.nullable(),
      pullRequest: z.object({
        state: text,
        viewerCanUpdate: z.boolean(),
        author: z.looseObject({ login }).nullable(),
        reviewRequests: z.object({
          nodes: z.array(z.object({ requestedReviewer: Requested.nullable() }).nullable()).max(100),
        }),
        latestReviews: z.object({
          nodes: z
            .array(
              z
                .looseObject({
                  databaseId: z.number().int().positive().nullable(),
                  state: text,
                  submittedAt: text.nullable(),
                  author: Person.nullable(),
                })
                .nullable(),
            )
            .max(100),
        }),
        suggestedReviewers: z
          .array(
            z
              .object({ isAuthor: z.boolean(), isCommenter: z.boolean(), reviewer: Person })
              .nullable(),
          )
          .max(100)
          .nullable(),
      }),
    }),
  }),
});

const fields = "__typename number title state";
const issueFields = `... on Issue { ${fields} } ... on PullRequest { ${fields} isDraft }`;

function person(p: z.infer<typeof Person>): ForgePerson {
  return {
    login: p.login,
    ...(p.name ? { name: p.name } : {}),
    ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
  };
}

function reference(node: z.infer<typeof Found> | null | undefined): ForgeReference | undefined {
  if (!node?.number || node.title === undefined) return undefined;
  const pr = node.__typename === "PullRequest";
  if (!pr && node.__typename !== "Issue") return undefined;
  const state = node.state?.toUpperCase();
  return {
    number: node.number,
    title: node.title,
    kind: pr ? "pr" : "issue",
    state:
      state === "MERGED"
        ? "merged"
        : state === "CLOSED"
          ? "closed"
          : pr && node.isDraft
            ? "draft"
            : "open",
  };
}

/** Search words with GitHub's qualifier syntax taken out, so a query stays in this repository. */
function searchWords(query: string): string {
  return query
    .replace(/[^\w .-]/g, " ")
    .trim()
    .slice(0, 100);
}

/** Who can be mentioned, what `#` can point at, and who reviews a PR: one request each. */
export class GitHubPeople {
  readonly #api: GhApi;
  readonly #repository: ForgeRepository;
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repository = repository;
  }
  async people(query: string, signal: AbortSignal): Promise<ForgePerson[]> {
    const { owner, name } = this.#repository;
    const words = searchWords(query);
    const response = await this.#api.request("graphql", signal, {
      query: `query AcePeople($owner:String!,$name:String!,$query:String){ repository(owner:$owner,name:$name){ mentionableUsers(first:20,query:$query){ nodes { login name avatarUrl } } } }`,
      variables: { owner, name, query: words || null },
    });
    return decode(People, response.body)
      .data.repository.mentionableUsers.nodes.flatMap((p) => (p ? [person(p)] : []))
      .slice(0, 20);
  }
  /** Open issues and PRs first, then recently updated ones; an exact number leads. */
  async references(query: string, signal: AbortSignal): Promise<ForgeReference[]> {
    const { owner, name } = this.#repository;
    const words = searchWords(query);
    const number = /^\d{1,9}$/.test(words) ? Number(words) : 0;
    const scope = `repo:${owner}/${name} sort:updated-desc`;
    // A bare number is matched exactly rather than searched as words in titles.
    const terms = number ? "" : ` ${words}`;
    const response = await this.#api.request("graphql", signal, {
      query: `query AceReferences($owner:String!,$name:String!,$open:String!,$recent:String!,$number:Int!,$exact:Boolean!){ open: search(type:ISSUE,query:$open,first:10){ nodes { ${issueFields} } } recent: search(type:ISSUE,query:$recent,first:10){ nodes { ${issueFields} } } repository(owner:$owner,name:$name){ issueOrPullRequest(number:$number) @include(if:$exact) { ${issueFields} } } }`,
      variables: {
        owner,
        name,
        open: `${scope} is:open${terms}`,
        recent: `${scope}${terms}`,
        number: number || 1,
        exact: number > 0,
      },
    });
    const data = decode(References, response.body).data;
    const all = [
      data.repository?.issueOrPullRequest,
      ...data.open.nodes,
      ...data.recent.nodes,
    ].flatMap((node) => reference(node) ?? []);
    const seen = new Set<number>();
    return all.filter((r) => !seen.has(r.number) && seen.add(r.number)).slice(0, 20);
  }
  async reviewers(number: number, signal: AbortSignal): Promise<ForgePrReviewers> {
    const { owner, name } = this.#repository;
    const user = "login avatarUrl";
    const response = await this.#api.request("graphql", signal, {
      query: `query AcePrReviewers($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ viewerPermission pullRequest(number:$number){ state viewerCanUpdate author { login } reviewRequests(first:100){ nodes { requestedReviewer { __typename ... on User { ${user} } ... on Bot { ${user} } ... on Mannequin { ${user} } ... on Team { slug name } } } } latestReviews(first:100){ nodes { databaseId state submittedAt author { login avatarUrl } } } suggestedReviewers { isAuthor isCommenter reviewer { login name avatarUrl } } } } }`,
      variables: { owner, name, number },
    });
    const repository = decode(Reviewers, response.body).data.repository;
    const pr = repository.pullRequest;
    const requested = pr.reviewRequests.nodes.flatMap((node): ForgeRequestedReviewer[] => {
      const r = node?.requestedReviewer;
      if (!r) return [];
      if (r.__typename === "Team")
        return r.slug ? [{ kind: "team", slug: r.slug, name: r.name ?? r.slug }] : [];
      return r.login
        ? [{ kind: "user", login: r.login, ...(r.avatarUrl ? { avatarUrl: r.avatarUrl } : {}) }]
        : [];
    });
    const reviews = pr.latestReviews.nodes.flatMap((r) => {
      const state = ReviewStates.find((s) => s === r?.state);
      if (!r?.databaseId || !r.author || !state) return [];
      return [
        {
          id: r.databaseId,
          login: r.author.login,
          ...(r.author.avatarUrl ? { avatarUrl: r.author.avatarUrl } : {}),
          state,
          submittedAt: r.submittedAt,
        },
      ];
    });
    const write = ["ADMIN", "MAINTAIN", "WRITE"].includes(repository.viewerPermission ?? "");
    const open = pr.state === "OPEN";
    return {
      requested,
      reviews,
      suggested: (pr.suggestedReviewers ?? []).flatMap((s) =>
        s ? [{ ...person(s.reviewer), isAuthor: s.isAuthor, isCommenter: s.isCommenter }] : [],
      ),
      author: pr.author?.login ?? null,
      canRequest: open && pr.viewerCanUpdate,
      canDismiss: open && write,
    };
  }
}
