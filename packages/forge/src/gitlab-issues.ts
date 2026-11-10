import { z } from "zod";
import { ForgeRepository } from "@ace/protocol/forge";
import {
  ForgeIssueDetail,
  ForgeIssueSearch,
  ForgeIssueWrite,
  type ForgeIssueList,
  type ForgeIssueRef,
} from "@ace/protocol/forge-issues";
import type { CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { GitLabApi } from "./gitlab-api.ts";
import {
  GitLabIssue,
  GitLabNote,
  GitLabProject,
  GitLabUser,
  accessLevel,
  decode,
  hasNextPage,
  issueRow,
  issuesEnabled,
  noteEvent,
  projectPath,
  totalHeader,
} from "./gitlab-issue-records.ts";
import { gitlabIssueChange, planGitLabIssueWrite } from "./gitlab-issue-writes.ts";
import { issueWriteLanded } from "./issue-write-plan.ts";
import { ReadBudget } from "./read-budget.ts";
import type { WriteDispatch } from "./write-dispatch.ts";

const pageSize = 25;
/** Lists stop at page 40 (1,000 rows), as GitHub's search does. */
const lastListPage = 40;
const lastTimelinePage = 120;
const unavailable = "This repository is archived or has disabled issues.";
const markerFor = (id: string) => `<!-- ace-issue-action:${encodeURIComponent(id)} -->`;
const IssuePage = z.array(GitLabIssue).max(pageSize);
/** A count read: only its `x-total` header matters. */
const CountPage = z.array(z.unknown());
const NotePage = z.array(GitLabNote).max(pageSize);
const Users = z.array(GitLabUser).max(100);
const IssueNumber = z.number().int().positive();
const TimelinePage = z.number().int().min(1).max(lastTimelinePage);
const ActionId = z.string().min(1).max(256);
const Marked = z
  .array(
    z.looseObject({
      iid: z.number().int().positive().optional(),
      description: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
    }),
  )
  .max(100);

/**
 * GitLab issues through the user's identity-pinned glab runner (ADR 0117): the same contract as
 * GitHub's issues, so the durable issue-action journal works for both. Docs:
 * docs.gitlab.com/api/issues/, docs.gitlab.com/api/notes/, docs.gitlab.com/api/users/.
 */
export class GitLabIssues {
  readonly repository: ForgeRepository;
  readonly #api: GitLabApi;
  readonly #root: string;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    this.repository = ForgeRepository.parse(options.repository);
    if (this.repository.forge !== "gitlab") throw new ForgeError("unsupported");
    this.#api = new GitLabApi(options.runner, this.repository.host);
    this.#root = projectPath(this.repository);
  }
  async #read<T>(schema: z.ZodType<T>, path: string, signal: AbortSignal, budget: ReadBudget) {
    const response = await this.#api.get(path, signal, budget);
    return { headers: response.headers, value: decode(schema, response.body) };
  }
  async #viewer(signal: AbortSignal, budget: ReadBudget) {
    return (await this.#read(GitLabUser, "user", signal, budget)).value;
  }
  async #project(signal: AbortSignal, budget: ReadBudget) {
    return (await this.#read(GitLabProject, this.#root, signal, budget)).value;
  }

  async listIssues(input: ForgeIssueSearch, signal: AbortSignal): Promise<ForgeIssueList> {
    const query = ForgeIssueSearch.parse(input);
    // GitLab can't order issues by comment count, and sorting every row here isn't bounded.
    if (query.sort === "comments") throw new ForgeError("unsupported");
    const budget = new ReadBudget();
    const [viewer, project] = await Promise.all([
      this.#viewer(signal, budget),
      this.#project(signal, budget),
    ]);
    const login = (name: string) => (name === "@me" ? viewer.username : name);
    const filter = new URLSearchParams({
      scope: "all",
      order_by: `${query.sort}_at`,
      sort: query.order,
    });
    if (query.search.trim()) filter.set("search", query.search.trim());
    if (query.labels.length) {
      if (query.labels.some((label) => label.includes(","))) throw new ForgeError("unsupported");
      filter.set("labels", query.labels.join(","));
    }
    if (query.milestone) filter.set("milestone", query.milestone);
    if (query.author) filter.set("author_username", login(query.author));
    if (query.assignee) filter.set("assignee_username", login(query.assignee));
    const path = (state: "open" | "closed", size: number, page: number, details: boolean) => {
      const params = new URLSearchParams(filter);
      params.set("state", state === "open" ? "opened" : "closed");
      params.set("per_page", String(size));
      params.set("page", String(page));
      if (details) params.set("with_labels_details", "true");
      return `${this.#root}/issues?${params}`;
    };
    const other = query.state === "open" ? "closed" : "open";
    // The other state's count is one row with the same filters, its total in `x-total`.
    const [page, count] = await Promise.all([
      this.#read(IssuePage, path(query.state, pageSize, query.page, true), signal, budget),
      this.#read(CountPage, path(other, 1, 1, false), signal, budget),
    ]);
    const rows = page.value.flatMap((record) => issueRow(this.repository, record) ?? []);
    const pageTotal = totalHeader(page.headers);
    const otherTotal = totalHeader(count.headers);
    // Past 10,000 rows GitLab stops counting: the rows seen are a lower bound.
    const total = pageTotal ?? (query.page - 1) * pageSize + page.value.length;
    const more = hasNextPage(page.headers, query.page, pageSize, page.value.length);
    const canCreate = issuesEnabled(project);
    return {
      repository: this.repository,
      viewer: viewer.username,
      items: rows,
      total,
      ...(more && query.page < lastListPage ? { nextPage: query.page + 1 } : {}),
      counts:
        query.state === "open"
          ? { open: total, closed: otherTotal ?? 0 }
          : { open: otherTotal ?? 0, closed: total },
      canCreate,
      unavailableReason: canCreate ? "" : unavailable,
      incomplete:
        pageTotal === undefined || otherTotal === undefined || rows.length < page.value.length,
      truncated: total > lastListPage * pageSize || (more && query.page === lastListPage),
    };
  }

  async #detail(number: number, signal: AbortSignal) {
    IssueNumber.parse(number);
    const budget = new ReadBudget();
    const [record, project, viewer] = await Promise.all([
      this.#read(GitLabIssue, `${this.#root}/issues/${number}`, signal, budget),
      this.#project(signal, budget),
      this.#viewer(signal, budget),
    ]);
    const issue = record.value;
    const row = issueRow(this.repository, issue);
    if (!row || issue.iid !== number) throw new ForgeError("invalid_data");
    const enabled = issuesEnabled(project);
    // Planner (15) and above manage any issue; its author may edit, close and reopen their own.
    const triage = enabled && accessLevel(project) >= 15;
    const edit = triage || (enabled && issue.author?.id === viewer.id);
    const locked = issue.discussion_locked === true;
    const detail = decode(ForgeIssueDetail, {
      ...row,
      body: (issue.description ?? "").slice(0, 65_536),
      ...(issue.confidential === undefined ? {} : { confidential: issue.confidential }),
      permissions: {
        edit,
        close: edit,
        reopen: edit,
        comment: enabled && (!locked || triage),
        triage,
        reason: !enabled
          ? unavailable
          : locked
            ? "This discussion is locked. GitLab restricts who can comment."
            : "Your glab account's GitLab permissions determine the available actions.",
      },
      milestoneNumber: issue.milestone?.id ?? null,
      relatedThreads: [],
      relatedThreadsTruncated: false,
    });
    return { detail, issue, budget };
  }
  async issueDetail(number: number, signal: AbortSignal): Promise<ForgeIssueDetail> {
    return (await this.#detail(number, signal)).detail;
  }

  /** User notes are comments and system notes activity, oldest first. */
  async issueTimeline(number: number, page: number, signal: AbortSignal) {
    IssueNumber.parse(number);
    TimelinePage.parse(page);
    const { headers, value: notes } = await this.#read(
      NotePage,
      `${this.#root}/issues/${number}/notes?sort=asc&order_by=created_at&per_page=${pageSize}&page=${page}`,
      signal,
      new ReadBudget(),
    );
    const more = hasNextPage(headers, page, pageSize, notes.length);
    const total = totalHeader(headers);
    return {
      events: notes.map((note) => noteEvent(this.repository, number, note)),
      ...(more && page < lastTimelinePage ? { nextPage: page + 1 } : {}),
      ...(total === undefined
        ? {}
        : { lastPage: Math.min(lastTimelinePage, Math.max(1, Math.ceil(total / pageSize))) }),
      truncated: more && page === lastTimelinePage,
    };
  }

  /**
   * One issue write. Everything it reads first (permissions, the issue, user ids) happens
   * before `dispatch` admits the one request that changes GitLab.
   */
  async writeIssue(
    input: ForgeIssueWrite,
    actionId: string,
    signal: AbortSignal,
    dispatch?: WriteDispatch,
  ): Promise<ForgeIssueRef> {
    const value = gitlabIssueChange(ForgeIssueWrite.parse(input));
    ActionId.parse(actionId);
    const marker = markerFor(actionId);
    if (value.action === "create") {
      const budget = new ReadBudget();
      if (!issuesEnabled(await this.#project(signal, budget))) throw new ForgeError("forbidden");
      const body = { title: value.title, description: `${value.body}\n\n${marker}` };
      const created = await this.#api.write(
        `${this.#root}/issues`,
        "POST",
        body,
        signal,
        budget,
        dispatch,
      );
      const record = decode(GitLabIssue, created.body);
      return { repository: this.repository, number: record.iid };
    }
    const { detail, issue, budget } = await this.#detail(value.number, signal);
    const path = `${this.#root}/issues/${value.number}`;
    if (value.action === "comment") {
      if (!detail.permissions.comment) throw new ForgeError("forbidden");
      const body = { body: `${value.body}\n\n${marker}` };
      const note = await this.#api.write(`${path}/notes`, "POST", body, signal, budget, dispatch);
      decode(GitLabNote, note.body);
      return detail.ref;
    }
    const plan = planGitLabIssueWrite(detail, value);
    if (plan.kind === "conflict" || plan.kind === "forbidden") throw new ForgeError(plan.kind);
    if (plan.kind === "done") return detail.ref;
    const body =
      plan.kind === "put"
        ? plan.body
        : { assignee_ids: await this.#userIds(plan.usernames, issue, signal, budget) };
    const updated = decode(
      GitLabIssue,
      (await this.#api.write(path, "PUT", body, signal, budget, dispatch)).body,
    );
    if (updated.iid !== value.number) throw new ForgeError("invalid_data");
    return detail.ref;
  }
  /**
   * GitLab assigns by user id. Current assignees' ids come from the issue; each new one is
   * looked up by exact username. No one assigned is `[0]`, GitLab's "unassign all".
   */
  async #userIds(
    usernames: readonly string[],
    issue: GitLabIssue,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<number[]> {
    const known = new Map(issue.assignees.map((user) => [user.username.toLowerCase(), user.id]));
    const ids: number[] = [];
    for (const username of usernames) {
      let id = known.get(username.toLowerCase());
      if (id === undefined) {
        const { value: users } = await this.#read(
          Users,
          `users?username=${encodeURIComponent(username)}`,
          signal,
          budget,
        );
        id = users.find((user) => user.username.toLowerCase() === username.toLowerCase())?.id;
      }
      if (id === undefined) throw new ForgeError("not_found");
      ids.push(id);
    }
    return ids.length ? ids : [0];
  }

  /** Read-only recovery. Absence within the bounded window never authorizes another write. */
  async reconcileIssue(
    input: ForgeIssueWrite,
    actionId: string,
    signal: AbortSignal,
  ): Promise<ForgeIssueRef | null> {
    const value = gitlabIssueChange(ForgeIssueWrite.parse(input));
    if (value.action !== "create" && value.action !== "comment") {
      const current = await this.issueDetail(value.number, signal);
      return issueWriteLanded(current, value) ? current.ref : null;
    }
    const marker = markerFor(actionId);
    const budget = new ReadBudget();
    for (let page = 1; page <= 10; page++) {
      const path =
        value.action === "create"
          ? `${this.#root}/issues?scope=all&state=all&order_by=created_at&sort=desc&per_page=100&page=${page}`
          : `${this.#root}/issues/${value.number}/notes?sort=desc&order_by=created_at&per_page=100&page=${page}`;
      const { headers, value: records } = await this.#read(Marked, path, signal, budget);
      const found = records.find((record) =>
        (value.action === "create" ? record.description : record.body)?.includes(marker),
      );
      const number = value.action === "comment" ? value.number : found?.iid;
      if (found && number) return { repository: this.repository, number };
      if (!hasNextPage(headers, page, 100, records.length)) break;
    }
    return null;
  }
}
