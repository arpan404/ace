import type { IssuesSearch, PullsSearch } from "@ace/ui-core";
import type { InboxSearch } from "./inbox-model.ts";

/*
 * A list's filters as one line of search qualifiers (`is:pr is:open author:sam label:bug`),
 * the way the search field shows them, and back. Words that aren't a known qualifier stay as
 * the free-text search, so GitHub's own search still sees them. Pure.
 */

/** One word of the line: `key:value`, or plain text. Quoted values keep their spaces. */
interface Token {
  key: string | undefined;
  value: string;
}

function tokens(text: string): Token[] {
  const found: Token[] = [];
  const pattern = /(?:([\w-]+):)?(?:"([^"]*)"?|(\S+))/g;
  for (const match of text.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? "";
    if (key === undefined && !value) continue;
    found.push({ key, value });
  }
  return found;
}

const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replaceAll('"', "")}"` : value);
const join = (parts: readonly (string | false | undefined)[]) =>
  parts.filter((part): part is string => !!part).join(" ");
/** A token as it was written, for the free text it falls back to. */
const plain = (token: Token) =>
  token.key === undefined ? token.value : `${token.key}:${quote(token.value)}`;

/** The pull request list's filters as a search line. */
export function prQueryText(search: PullsSearch): string {
  const state = search.state ?? "open";
  return join([
    "is:pr",
    state !== "all" && `is:${state}`,
    search.draft === "only" && "draft:true",
    search.draft === "hide" && "draft:false",
    search.who === "authored" && "author:@me",
    search.who === "reviewing" && "review-requested:@me",
    search.author && `author:${search.author}`,
    ...(search.labels ?? []).map((label) => `label:${quote(label)}`),
    search.review === "approved" && "review:approved",
    search.review === "changes" && "review:changes_requested",
    search.review === "required" && "review:required",
    search.review === "none" && "review:none",
    search.checks === "passing" && "status:success",
    search.checks === "failing" && "status:failure",
    search.q?.trim(),
  ]);
}

const prReviews = {
  approved: "approved",
  changes_requested: "changes",
  required: "required",
  none: "none",
} as const;

/**
 * A search line as the pull request list's filters: every filter it can say is set, or
 * cleared when the line leaves it out. No `is:` state shows every state.
 */
export function prSearchOf(text: string): Partial<PullsSearch> {
  const patch: Partial<PullsSearch> = {
    state: "all",
    draft: undefined,
    who: undefined,
    author: undefined,
    labels: undefined,
    review: undefined,
    checks: undefined,
  };
  const labels: string[] = [];
  const rest: string[] = [];
  for (const token of tokens(text)) {
    const value = token.value.toLowerCase();
    if (token.key === "is" && value === "pr") continue;
    if (token.key === "is" && (value === "open" || value === "closed" || value === "merged"))
      patch.state = value;
    else if (token.key === "is" && value === "draft") patch.draft = "only";
    else if (token.key === "draft" && (value === "true" || value === "false"))
      patch.draft = value === "true" ? "only" : "hide";
    else if (token.key === "author" && value === "@me") patch.who = "authored";
    else if (token.key === "review-requested" && value === "@me") patch.who = "reviewing";
    else if (token.key === "author" && token.value) patch.author = token.value;
    else if (token.key === "label" && token.value) labels.push(token.value);
    else if (token.key === "review" && value in prReviews)
      patch.review = prReviews[value as keyof typeof prReviews];
    else if (token.key === "status" && (value === "success" || value === "failure"))
      patch.checks = value === "success" ? "passing" : "failing";
    else rest.push(plain(token));
  }
  if (labels.length) patch.labels = labels;
  // The address keeps open as its default, unnamed.
  if (patch.state === "open") patch.state = undefined;
  patch.q = rest.join(" ") || undefined;
  return patch;
}

/** The issue list's filters as a search line. */
export function issueQueryText(search: IssuesSearch): string {
  return join([
    "is:issue",
    `is:${search.state ?? "open"}`,
    search.who === "assigned" && "assignee:@me",
    search.who === "created" && "author:@me",
    search.author && `author:${search.author}`,
    ...(search.labels ?? []).map((label) => `label:${quote(label)}`),
    search.q?.trim(),
  ]);
}

/** A search line as the issue list's filters; issues are open unless it says closed. */
export function issueSearchOf(text: string): Partial<IssuesSearch> {
  const patch: Partial<IssuesSearch> = {
    state: undefined,
    who: undefined,
    author: undefined,
    labels: undefined,
  };
  const labels: string[] = [];
  const rest: string[] = [];
  for (const token of tokens(text)) {
    const value = token.value.toLowerCase();
    if (token.key === "is" && (value === "issue" || value === "open")) continue;
    if (token.key === "is" && value === "closed") patch.state = "closed";
    else if (token.key === "assignee" && value === "@me") patch.who = "assigned";
    else if (token.key === "author" && value === "@me") patch.who = "created";
    else if (token.key === "author" && token.value) patch.author = token.value;
    else if (token.key === "label" && token.value) labels.push(token.value);
    else rest.push(plain(token));
  }
  if (labels.length) patch.labels = labels;
  patch.q = rest.join(" ") || undefined;
  return patch;
}

/** The inbox's filters as a filter line: `is:unread reason:mention repo:acme/ace`. */
export function inboxQueryText(search: InboxSearch): string {
  return join([
    search.view !== "all" && "is:unread",
    search.only === "participating" && "is:participating",
    search.reason && `reason:${search.reason}`,
    search.repo && `repo:${search.repo.split("/").slice(1).join("/")}`,
  ]);
}

/**
 * A filter line as the inbox's filters. `repo:owner/name` keeps the host of `repos` (the
 * repositories the inbox has seen, as `host/owner/name`), else github.com. GitHub can't search
 * notifications' words, so anything else is left out.
 */
export function inboxSearchOf(text: string, repos: readonly string[]): Partial<InboxSearch> {
  const patch: Partial<InboxSearch> = {
    view: "all",
    only: undefined,
    reason: undefined,
    repo: undefined,
  };
  for (const token of tokens(text)) {
    const value = token.value.toLowerCase();
    if (token.key === "is" && value === "unread") patch.view = undefined;
    else if (token.key === "is" && value === "read") patch.view = "all";
    else if (token.key === "is" && value === "participating") patch.only = "participating";
    else if (token.key === "reason" && value) patch.reason = value.replaceAll("-", "_");
    else if (token.key === "repo" && value.includes("/"))
      patch.repo =
        repos.find((repo) => repo.toLowerCase().endsWith(`/${value}`)) ?? `github.com/${value}`;
  }
  return patch;
}
