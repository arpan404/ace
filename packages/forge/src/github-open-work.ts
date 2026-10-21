import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import { ForgePrSearch, type ForgeOpenWork, type ForgePrRow } from "@ace/protocol/forge-browser";
import { ForgeIssueSearch, type ForgeIssueRow } from "@ace/protocol/forge-issues";
import { PrIndicator, prIndicator } from "./github-browser-enrichment.ts";
import { prSearchQuery } from "./github-browser.ts";
import { issueSearchQuery } from "./github-issues.ts";
import { ForgeError } from "./errors.ts";
import type { GhApi } from "./http.ts";

const text = z.string();
const login = z.looseObject({ login: text });
const names = <T extends z.ZodType>(node: T) =>
  z.looseObject({ nodes: z.array(node.nullable()).max(100) });
const PrNode = PrIndicator.extend({
  number: z.number().int().positive(),
  title: text,
  url: text,
  state: text,
  isDraft: z.boolean(),
  updatedAt: text,
  author: z.looseObject({ login: text, avatarUrl: text.optional() }).nullable(),
  labels: names(z.looseObject({ name: text })).nullable(),
});
const IssueNode = z.looseObject({
  number: z.number().int().positive(),
  title: text,
  url: text,
  state: text,
  createdAt: text,
  updatedAt: text,
  author: login.nullable(),
  labels: names(z.looseObject({ name: text })).nullable(),
  assignees: names(login).nullable(),
  milestone: z.looseObject({ title: text }).nullable(),
});
const search = <T extends z.ZodType>(node: T) =>
  z.looseObject({
    issueCount: z.number().int().nonnegative(),
    nodes: z.array(node.nullable()).max(25),
  });
const PrSearch = search(PrNode);
const OpenWorkBody = z.looseObject({
  data: z.looseObject({
    pullRequests: PrSearch,
    failingPullRequests: PrSearch,
    issues: search(IssueNode),
  }),
});
const prFields =
  "number title url state isDraft updatedAt author { login avatarUrl } labels(first: 100) { nodes { name } } comments { totalCount } reviews { totalCount } statusCheckRollup { state }";
const issueFields =
  "number title url state createdAt updatedAt author { login } labels(first: 100) { nodes { name } } assignees(first: 100) { nodes { login } } milestone { title }";
const query = `query OpenWork($pullRequests: String!, $failingPullRequests: String!, $issues: String!) {
  pullRequests: search(type: ISSUE, query: $pullRequests, first: 25) { issueCount nodes { ... on PullRequest { ${prFields} } } }
  failingPullRequests: search(type: ISSUE, query: $failingPullRequests, first: 25) { issueCount nodes { ... on PullRequest { ${prFields} } } }
  issues: search(type: ISSUE, query: $issues, first: 25) { issueCount nodes { ... on Issue { ${issueFields} } } }
}`;
/** REST search sorts by parameter; GraphQL search takes the same order as a qualifier. */
const newestFirst = " sort:updated-desc";

/**
 * New thread's open pull requests, failing pull requests and open issues in one GraphQL request,
 * with the same searches, order and row fields as the separate list reads.
 */
export async function githubOpenWork(
  api: GhApi,
  repository: ForgeRepository,
  signal: AbortSignal,
): Promise<ForgeOpenWork> {
  const response = await api.request("graphql", signal, {
    query,
    variables: {
      pullRequests:
        prSearchQuery(repository, ForgePrSearch.parse({ state: "active" })) + newestFirst,
      failingPullRequests:
        prSearchQuery(repository, ForgePrSearch.parse({ state: "active", ci: "failure" })) +
        newestFirst,
      issues: issueSearchQuery(repository, ForgeIssueSearch.parse({})) + newestFirst,
    },
  });
  const parsed = OpenWorkBody.safeParse(response.body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const { pullRequests, failingPullRequests, issues } = parsed.data.data;
  const prs = (found: z.infer<typeof PrSearch>) => ({
    items: present(found.nodes).map((node) => prRow(repository, node)),
    total: found.issueCount,
  });
  return {
    repository,
    pullRequests: prs(pullRequests),
    failingPullRequests: prs(failingPullRequests),
    issues: {
      items: present(issues.nodes).map((node) => issueRow(repository, node)),
      total: issues.issueCount,
    },
  };
}

/** GitHub answers null for a result the viewer may no longer see. */
function present<T>(nodes: readonly (T | null)[]): T[] {
  return nodes.filter((node): node is T => node !== null);
}

function prRow(repository: ForgeRepository, node: z.infer<typeof PrNode>): ForgePrRow {
  return {
    ...prIndicator(node),
    raw: node,
    ref: { repository, number: node.number },
    title: node.title,
    url: node.url,
    author: node.author?.login ?? "deleted user",
    ...(node.author?.avatarUrl ? { authorAvatarUrl: node.author.avatarUrl } : {}),
    labels: present(node.labels?.nodes ?? []).map((label) => label.name),
    updatedAt: node.updatedAt,
    state:
      node.state === "MERGED"
        ? "merged"
        : node.state === "CLOSED"
          ? "closed"
          : node.isDraft
            ? "draft"
            : "open",
  };
}

function issueRow(repository: ForgeRepository, node: z.infer<typeof IssueNode>): ForgeIssueRow {
  return {
    raw: node,
    ref: { repository, number: node.number },
    title: node.title,
    url: node.url,
    author: node.author?.login ?? "deleted user",
    state: node.state === "CLOSED" ? "closed" : "open",
    labels: present(node.labels?.nodes ?? []).map((label) => label.name),
    assignees: present(node.assignees?.nodes ?? []).map((user) => user.login),
    milestone: node.milestone?.title ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}
