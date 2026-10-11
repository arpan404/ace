import type { WriteDispatch } from "./write-dispatch.ts";
import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import {
  ForgeIssueSearch,
  ForgeIssueWrite,
  type ForgeIssueDetail,
  type ForgeIssueList,
  type ForgeIssueRow,
} from "@ace/protocol/forge-issues";
import type { GhApi } from "./http.ts";
import { ForgeError } from "./errors.ts";

const user = z.looseObject({ login: z.string().max(256) });
export const GitHubIssueRecord = z.looseObject({
  number: z.number().int().positive(),
  title: z.string().max(65_536),
  body: z.string().max(65_536).nullable().optional(),
  html_url: z.string().max(4096),
  user: user.nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.looseObject({ name: z.string().max(256) })).max(100),
  assignees: z.array(user).max(100),
  milestone: z.looseObject({ title: z.string().max(256) }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  locked: z.boolean().optional(),
  pull_request: z.unknown().optional(),
});
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
function searchQuery(repo: ForgeRepository, query: ForgeIssueSearch) {
  return [
    `repo:${repo.owner}/${repo.name}`,
    "is:issue",
    `is:${query.state}`,
    ...query.search
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => JSON.stringify(word)),
    ...(query.author ? [`author:${query.author}`] : []),
    ...(query.assignee ? [`assignee:${query.assignee}`] : []),
    ...query.labels.map((label) => `label:${JSON.stringify(label)}`),
    ...(query.milestone ? [`milestone:${JSON.stringify(query.milestone)}`] : []),
  ].join(" ");
}
const count = z.object({ issueCount: z.number().int().nonnegative() });
export class GitHubIssues {
  readonly #api: GhApi;
  readonly #repo: ForgeRepository;
  readonly #root: string;
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#repo = repository;
    this.#root = `repos/${repository.owner}/${repository.name}`;
  }
  #row(record: z.infer<typeof GitHubIssueRecord>): ForgeIssueRow {
    if (record.pull_request !== undefined) throw new ForgeError("invalid_data");
    return {
      ref: { repository: this.#repo, number: record.number },
      title: record.title,
      url: record.html_url,
      author: record.user?.login ?? "deleted user",
      state: record.state,
      labels: record.labels.map((l) => l.name),
      assignees: record.assignees.map((u) => u.login),
      milestone: record.milestone?.title ?? null,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      raw: record,
    };
  }
  async list(input: ForgeIssueSearch, signal: AbortSignal): Promise<ForgeIssueList> {
    const query = ForgeIssueSearch.parse(input);
    const params = new URLSearchParams({
      q: searchQuery(this.#repo, query),
      sort: query.sort,
      order: query.order,
      per_page: "25",
      page: String(query.page),
    });
    const page = decode(
      z.object({
        total_count: z.number().int().nonnegative(),
        incomplete_results: z.boolean(),
        items: z.array(GitHubIssueRecord).max(25),
      }),
      (await this.#api.request(`search/issues?${params}`, signal)).body,
    );
    const fields = ["open", "closed"].map(
      (state) =>
        `${state}: search(type:ISSUE,query:${JSON.stringify(searchQuery(this.#repo, ForgeIssueSearch.parse({ ...query, state })))},first:1) { issueCount }`,
    );
    const counts = decode(
      z.object({ data: z.object({ open: count, closed: count }) }),
      (await this.#api.request("graphql", signal, { query: `query { ${fields.join(" ")} }` })).body,
    ).data;
    const repository = decode(
      z.looseObject({ archived: z.boolean(), has_issues: z.boolean() }),
      (await this.#api.request(this.#root, signal)).body,
    );
    const canCreate = !repository.archived && repository.has_issues;
    return {
      repository: this.#repo,
      items: page.items.map((record) => this.#row(record)),
      total: page.total_count,
      ...(query.page * 25 < Math.min(1000, page.total_count) ? { nextPage: query.page + 1 } : {}),
      counts: { open: counts.open.issueCount, closed: counts.closed.issueCount },
      canCreate,
      unavailableReason: canCreate ? "" : "This repository is archived or has disabled issues.",
      incomplete: page.incomplete_results,
      truncated: page.total_count > 1000,
    };
  }
  async detail(number: number, signal: AbortSignal): Promise<ForgeIssueDetail> {
    z.number().int().positive().parse(number);
    const record = decode(
      GitHubIssueRecord,
      (await this.#api.request(`${this.#root}/issues/${number}`, signal)).body,
    );
    if (record.number !== number) throw new ForgeError("invalid_data");
    const { owner, name } = this.#repo;
    const response = await this.#api.request("graphql", signal, {
      query: `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { isArchived viewerPermission issue(number:$number) { updatedAt viewerCanUpdate viewerCanClose viewerCanReopen } } }`,
      variables: { owner, name, number },
    });
    const permissions = decode(
      z.object({
        data: z.object({
          repository: z.object({
            isArchived: z.boolean(),
            viewerPermission: z.string().nullable(),
            issue: z.object({
              updatedAt: z.string(),
              viewerCanUpdate: z.boolean(),
              viewerCanClose: z.boolean(),
              viewerCanReopen: z.boolean(),
            }),
          }),
        }),
      }),
      response.body,
    ).data.repository;
    if (permissions.issue.updatedAt !== record.updated_at) throw new ForgeError("conflict");
    const writable = !permissions.isArchived;
    const comment =
      writable &&
      (!record.locked ||
        ["ADMIN", "MAINTAIN", "WRITE"].includes(permissions.viewerPermission ?? ""));
    return {
      ...this.#row(record),
      body: record.body ?? "",
      permissions: {
        edit: writable && permissions.issue.viewerCanUpdate,
        close: writable && permissions.issue.viewerCanClose,
        reopen: writable && permissions.issue.viewerCanReopen,
        comment,
        reason: permissions.isArchived
          ? "This repository is archived."
          : record.locked
            ? "This conversation is locked. GitHub restricts who can comment."
            : "Your gh account's GitHub permissions determine the available actions.",
      },
      relatedThreads: [],
      relatedThreadsTruncated: false,
    };
  }
  async timeline(number: number, page: number, signal: AbortSignal) {
    z.number().int().positive().parse(number);
    z.number().int().min(1).max(120).parse(page);
    const path = `${this.#root}/issues/${number}/timeline?per_page=25&page=${page}`;
    const response = await this.#api.request(path, signal);
    const events = decode(
      z
        .array(
          z.looseObject({
            id: z.union([z.string(), z.number()]).optional(),
            node_id: z.string().optional(),
            event: z.string().max(256),
            actor: user.nullable().optional(),
            user: user.nullable().optional(),
            created_at: z.string().nullable().optional(),
            body: z.string().max(65_536).nullable().optional(),
            html_url: z.string().max(4096).optional(),
            source: z
              .looseObject({
                issue: z
                  .looseObject({
                    pull_request: z.looseObject({ html_url: z.string().max(4096) }).optional(),
                  })
                  .optional(),
              })
              .optional(),
          }),
        )
        .max(25),
      response.body,
    );
    const next = this.#api.next(response, path);
    return {
      events: events
        .map((record, index) => ({
          id: String(record.id ?? record.node_id ?? `${page}:${index}`),
          kind: record.event === "commented" ? ("issue_comment" as const) : ("activity" as const),
          event: record.event,
          actor: record.actor?.login ?? record.user?.login ?? "GitHub",
          at: record.created_at ?? null,
          body: record.body ?? undefined,
          url: record.html_url,
          pullRequestUrl: record.source?.issue?.pull_request?.html_url,
          raw: record,
        }))
        .toSorted((a, b) => (a.at ?? "").localeCompare(b.at ?? "")),
      ...(next && page < 120 ? { nextPage: page + 1 } : {}),
      truncated: Boolean(next && page === 120),
    };
  }
  async write(
    input: ForgeIssueWrite,
    actionId: string,
    signal: AbortSignal,
    dispatch?: WriteDispatch,
  ) {
    const value = ForgeIssueWrite.parse(input);
    z.string().min(1).max(256).parse(actionId);
    const marker = `<!-- ace-issue-action:${encodeURIComponent(actionId)} -->`;
    if (value.action === "create") {
      const repo = decode(
        z.looseObject({ archived: z.boolean(), has_issues: z.boolean() }),
        (await this.#api.request(this.#root, signal)).body,
      );
      if (repo.archived || !repo.has_issues) throw new ForgeError("forbidden");
      signal.throwIfAborted();
      const record = decode(
        GitHubIssueRecord,
        (
          await this.#api.request(
            `${this.#root}/issues`,
            signal,
            {
              title: value.title,
              body: `${value.body}\n\n${marker}`,
            },
            "POST",
            dispatch,
          )
        ).body,
      );
      return this.#row(record).ref;
    }
    const current = await this.detail(value.number, signal);
    if (value.action === "comment") {
      if (!current.permissions.comment) throw new ForgeError("forbidden");
      signal.throwIfAborted();
      decode(
        z.looseObject({ id: z.number().int().positive() }),
        (
          await this.#api.request(
            `${this.#root}/issues/${value.number}/comments`,
            signal,
            {
              body: `${value.body}\n\n${marker}`,
            },
            "POST",
            dispatch,
          )
        ).body,
      );
    } else {
      if (current.updatedAt !== value.expectedUpdatedAt) throw new ForgeError("conflict");
      if (
        value.action === "edit"
          ? !current.permissions.edit
          : value.state === "closed"
            ? !current.permissions.close
            : !current.permissions.reopen
      )
        throw new ForgeError("forbidden");
      const body =
        value.action === "edit" ? { title: value.title, body: value.body } : { state: value.state };
      signal.throwIfAborted();
      const record = decode(
        GitHubIssueRecord,
        (
          await this.#api.request(
            `${this.#root}/issues/${value.number}`,
            signal,
            body,
            "PATCH",
            dispatch,
          )
        ).body,
      );
      if (record.number !== value.number) throw new ForgeError("invalid_data");
    }
    return current.ref;
  }
  /** Read-only recovery. Absence within the bounded window never authorizes another POST. */
  async reconcile(input: ForgeIssueWrite, actionId: string, signal: AbortSignal) {
    const value = ForgeIssueWrite.parse(input);
    const marker = `<!-- ace-issue-action:${encodeURIComponent(actionId)} -->`;
    if (value.action === "edit" || value.action === "state") {
      const current = await this.detail(value.number, signal);
      const matches =
        value.action === "edit"
          ? current.title === value.title && current.body === value.body
          : current.state === value.state;
      return matches ? current.ref : null;
    }
    for (let page = 1; page <= 10; page++) {
      const path =
        value.action === "create"
          ? `${this.#root}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`
          : `${this.#root}/issues/${value.number}/comments?per_page=100&page=${page}`;
      const response = await this.#api.request(path, signal);
      const records = decode(
        z
          .array(
            z.looseObject({
              body: z.string().nullable().optional(),
              number: z.number().int().positive().optional(),
              pull_request: z.unknown().optional(),
            }),
          )
          .max(100),
        response.body,
      );
      const found = records.find(
        (record) => record.pull_request === undefined && record.body?.includes(marker),
      );
      const number = value.action === "comment" ? value.number : found?.number;
      if (found && number) return { repository: this.#repo, number };
      if (!this.#api.next(response, path)) break;
    }
    return null;
  }
}
