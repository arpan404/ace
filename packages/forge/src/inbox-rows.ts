import { z } from "zod";
import { ForgeRepository } from "@ace/protocol/forge";
import type { ForgeInboxRow, ForgeInboxSubjectState } from "@ace/protocol/forge-inbox";

const name = z
  .string()
  .regex(/^[\w.-]+$/)
  .max(256);
/** One notification thread as GitHub's REST API sends it; unknown fields are kept. */
export const GitHubNotification = z.looseObject({
  id: z.union([z.string().regex(/^\d{1,32}$/), z.number().int().nonnegative()]),
  unread: z.boolean(),
  reason: z.string().min(1).max(64),
  updated_at: z.string().max(64),
  last_read_at: z.string().max(64).nullable().optional(),
  subject: z.looseObject({
    title: z.string().max(65_536),
    url: z.string().max(4096).nullable().optional(),
    type: z.string().min(1).max(64),
  }),
  repository: z.looseObject({
    name,
    owner: z.looseObject({ login: name }),
    html_url: z.string().max(4096).optional(),
  }),
});
export type GitHubNotification = z.infer<typeof GitHubNotification>;

/**
 * The subject's API address split into what a row needs: `repos/{owner}/{name}/{kind}/{rest}`.
 * The address is only ever parsed here, never requested.
 */
function subjectPath(url: string | null | undefined): { kind: string; rest: string } | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const match = /^(?:\/api\/v3)?\/repos\/[^/]+\/[^/]+\/([a-z-]+)\/([^/?#]+)/.exec(parsed.pathname);
  return match?.[1] && match[2]
    ? { kind: match[1], rest: decodeURIComponent(match[2]) }
    : undefined;
}

/** A pull request's or issue's number from the subject's address (`…/pulls/229`, `…/issues/31`). */
export function subjectNumber(url: string | null | undefined): number | undefined {
  const path = subjectPath(url);
  if (!path || !["pulls", "issues", "discussions"].includes(path.kind)) return undefined;
  if (!/^[1-9]\d{0,9}$/.test(path.rest)) return undefined;
  return Number(path.rest);
}

/**
 * Where a subject opens on GitHub's website. Pull requests, issues, discussions and commits
 * open themselves; releases, check suites and unknown types open the repository's matching
 * page, since their address names an id the website doesn't use.
 */
export function subjectWebUrl(
  host: string,
  repository: { owner: string; name: string },
  type: string,
  url: string | null | undefined,
): string {
  const root = `https://${host}/${repository.owner}/${repository.name}`;
  const path = subjectPath(url);
  const number = subjectNumber(url);
  if (type === "PullRequest" && number) return `${root}/pull/${number}`;
  if (type === "Issue" && number) return `${root}/issues/${number}`;
  if (type === "Discussion")
    return number ? `${root}/discussions/${number}` : `${root}/discussions`;
  if (type === "Commit" && path?.kind === "commits" && /^[0-9a-f]{7,64}$/i.test(path.rest))
    return `${root}/commit/${path.rest}`;
  if (type === "Release") return `${root}/releases`;
  if (type === "CheckSuite") return `${root}/actions`;
  if (type === "RepositoryVulnerabilityAlert" || type === "RepositoryDependabotAlertsThread")
    return `${root}/security/dependabot`;
  return root;
}

/** One notification as an inbox row; `state` is filled in separately for PRs and issues. */
export function inboxRow(
  host: string,
  record: GitHubNotification,
  state?: ForgeInboxSubjectState,
): ForgeInboxRow {
  const repository = ForgeRepository.parse({
    forge: "github",
    host,
    owner: record.repository.owner.login,
    name: record.repository.name,
  });
  const number =
    record.subject.type === "PullRequest" ||
    record.subject.type === "Issue" ||
    record.subject.type === "Discussion"
      ? subjectNumber(record.subject.url)
      : undefined;
  return {
    id: String(record.id),
    repository,
    type: record.subject.type,
    title: record.subject.title,
    ...(number ? { number } : {}),
    ...(state ? { state } : {}),
    reason: record.reason,
    unread: record.unread,
    updatedAt: record.updated_at,
    lastReadAt: record.last_read_at ?? null,
    url: subjectWebUrl(host, repository, record.subject.type, record.subject.url),
  };
}

/** GitHub's poll interval header in seconds; 60 when missing or unreadable. */
export function pollSeconds(header: string | undefined): number {
  const value = Number(header);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 3_600) : 60;
}

/** A pull request's or issue's state as the GraphQL API says it. */
export function subjectState(node: unknown): ForgeInboxSubjectState | undefined {
  const parsed = z
    .looseObject({
      __typename: z.string(),
      state: z.string(),
      isDraft: z.boolean().optional(),
    })
    .safeParse(node);
  if (!parsed.success) return undefined;
  const { __typename, state, isDraft } = parsed.data;
  if (__typename === "PullRequest") {
    if (state === "MERGED") return "merged";
    if (state === "CLOSED") return "closed";
    if (state === "OPEN") return isDraft ? "draft" : "open";
    return undefined;
  }
  if (__typename === "Issue")
    return state === "CLOSED" ? "closed" : state === "OPEN" ? "open" : undefined;
  return undefined;
}
