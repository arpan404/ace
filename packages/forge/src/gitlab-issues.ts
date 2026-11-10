import { z } from "zod";
import { ForgeRepository } from "@ace/protocol/forge";
import { ForgeIssueSearch, ForgeIssueDetail, ForgeIssueWrite } from "@ace/protocol/forge-issues";
import type { CommandRunner } from "./command.ts";
import type { HostApiWrite } from "./read-only-api.ts";
import { ForgeError } from "./errors.ts";
import { GitLabApi } from "./gitlab-api.ts";
import { ReadBudget } from "./read-budget.ts";
import { WriteDispatch } from "./write-dispatch.ts";
import { applyMembers, issueWriteLanded, planIssueWrite } from "./issue-write-plan.ts";
import { Issue, IssueUser, Note, Project, decode, issueRow, issueUrl, morePages, totalHeader } from "./gitlab-issue-records.ts";

/** Exact issue mutations, used by SourceControl.writeIdentity. No MR endpoints admitted. */
export const gitlabIssueWrites: readonly HostApiWrite[] = [
  { method: "POST", endpoint: /^projects\/[^/?]+\/issues$/ },
  { method: "POST", endpoint: /^projects\/[^/?]+\/issues\/[1-9]\d*\/notes$/ },
  { method: "PUT", endpoint: /^projects\/[^/?]+\/issues\/[1-9]\d*$/ },
];
const markerFor = (id: string) => `<!-- ace-issue-action:${encodeURIComponent(id)} -->`;

/** Issues through the user's identity-pinned glab runner. Docs: GitLab Issues and Notes APIs. */
export class GitLabIssues {
  readonly #repository: ForgeRepository;
  readonly #api: GitLabApi;
  readonly #root: string;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    this.#repository = ForgeRepository.parse(options.repository);
    if (this.#repository.forge !== "gitlab") throw new ForgeError("unsupported");
    this.#api = new GitLabApi(options.runner, this.#repository.host);
    this.#root = `projects/${encodeURIComponent(`${this.#repository.owner}/${this.#repository.name}`)}`;
  }
  async #get(path: string, signal: AbortSignal, budget: ReadBudget) {
    return this.#api.request(path, signal, budget);
  }
  async #viewer(signal: AbortSignal, budget: ReadBudget) {
    return decode(IssueUser, (await this.#get("user", signal, budget)).body);
  }
  async #project(signal: AbortSignal, budget: ReadBudget) {
    return decode(Project, (await this.#get(this.#root, signal, budget)).body);
  }
  #enabled(project: z.infer<typeof Project>) {
    return !project.archived && project.issues_enabled !== false && project.issues_access_level !== "disabled";
  }
  async listIssues(input: ForgeIssueSearch, signal: AbortSignal) {
    const query = ForgeIssueSearch.parse(input);
    const budget = new ReadBudget();
    const viewer = await this.#viewer(signal, budget);
    const params = new URLSearchParams({ scope: "all", state: query.state === "open" ? "opened" : "closed",
      order_by: query.sort === "comments" ? "created_at" : `${query.sort}_at`, sort: query.order, per_page: "25", page: String(query.page) });
    if (query.search) params.set("search", query.search);
    if (query.labels.length) params.set("labels", query.labels.join(","));
    if (query.milestone) params.set("milestone", query.milestone);
    if (query.author) params.set("author_username", query.author === "@me" ? viewer.username : query.author);
    if (query.assignee) params.set("assignee_username[]", query.assignee === "@me" ? viewer.username : query.assignee);
    const response = await this.#get(`${this.#root}/issues?${params}`, signal, budget);
    let records = decode(z.array(Issue).max(25), response.body);
    const total = totalHeader(response.headers);
    const counts = { open: 0, closed: 0 };
    let incomplete = total === undefined;
    for (const state of ["open", "closed"] as const) {
      if (state === query.state && total !== undefined) { counts[state] = total; continue; }
      const filter = new URLSearchParams(params);
      filter.set("state", state === "open" ? "opened" : "closed");
      filter.set("per_page", "1"); filter.set("page", "1");
      const count = await this.#get(`${this.#root}/issues?${filter}`, signal, budget);
      decode(z.array(Issue).max(1), count.body);
      const value = totalHeader(count.headers);
      counts[state] = value ?? 0;
      incomplete ||= value === undefined;
    }
    let commentSortCapped = false;
    if (query.sort === "comments") {
      const all: z.infer<typeof Issue>[] = [];
      for (let page = 1; page <= 40; page++) {
        const filter = new URLSearchParams(params); filter.set("page", String(page));
        const part = page === query.page ? response : await this.#get(`${this.#root}/issues?${filter}`, signal, budget);
        const rows = decode(z.array(Issue).max(25), part.body);
        all.push(...rows);
        const more = morePages(part.headers, page, 25, rows.length);
        if (!more) break;
        if (page === 40) commentSortCapped = true;
      }
      all.sort((a, b) => (query.order === "asc" ? 1 : -1) * ((a.user_notes_count ?? 0) - (b.user_notes_count ?? 0)) || a.iid - b.iid);
      records = all.slice((query.page - 1) * 25, query.page * 25);
      incomplete ||= commentSortCapped;
    }
    const project = await this.#project(signal, budget);
    const more = morePages(response.headers, query.page, 25, records.length);
    return { repository: this.#repository, viewer: viewer.username,
      items: records.map(record => issueRow(this.#repository, record)),
      total: total ?? (query.page - 1) * 25 + records.length, counts,
      ...(more && query.page < 40 ? { nextPage: query.page + 1 } : {}),
      canCreate: this.#enabled(project), unavailableReason: this.#enabled(project) ? "" : "This repository is archived or has disabled issues.",
      incomplete, truncated: commentSortCapped || (total !== undefined && total > 1000) || (more && query.page === 40) };
  }
  async issueDetail(number: number, signal: AbortSignal) {
    z.number().int().positive().parse(number);
    const budget = new ReadBudget();
    const record = decode(Issue, (await this.#get(`${this.#root}/issues/${number}`, signal, budget)).body);
    if (record.iid !== number) throw new ForgeError("invalid_data");
    const project = await this.#project(signal, budget);
    const viewer = await this.#viewer(signal, budget);
    const level = Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0);
    const enabled = this.#enabled(project);
    const edit = enabled && (level >= 20 || record.author?.id === viewer.id);
    return ForgeIssueDetail.parse({ ...issueRow(this.#repository, record), body: record.description ?? "",
      confidential: record.confidential, milestoneNumber: record.milestone?.id ?? null,
      permissions: { edit, close: edit, reopen: edit, triage: enabled && level >= 20,
        comment: enabled && (!record.discussion_locked || level >= 20),
        reason: enabled ? "Your glab account's GitLab permissions determine the available actions." : "This repository is archived or has disabled issues." },
      relatedThreads: [], relatedThreadsTruncated: false });
  }
  async issueTimeline(number: number, page: number, signal: AbortSignal) {
    z.number().int().positive().parse(number); z.number().int().min(1).max(120).parse(page);
    const response = await this.#get(`${this.#root}/issues/${number}/notes?per_page=25&page=${page}&sort=asc&order_by=created_at`, signal, new ReadBudget());
    const notes = decode(z.array(Note).max(25), response.body);
    const more = morePages(response.headers, page, 25, notes.length);
    const total = totalHeader(response.headers);
    return { events: notes.map(note => ({ id: String(note.id), kind: note.system ? "activity" as const : "issue_comment" as const,
      event: note.system ? "system_note" : "commented", actor: note.author?.username ?? "GitLab",
      at: note.created_at, body: note.body, url: `${issueUrl(this.#repository, number)}#note_${note.id}`, raw: note })),
      ...(more && page < 120 ? { nextPage: page + 1 } : {}),
      ...(total !== undefined ? { lastPage: Math.min(120, Math.max(1, Math.ceil(total / 25))) } : {}),
      truncated: more && page === 120 };
  }
  async #userId(username: string, signal: AbortSignal, budget: ReadBudget) {
    const users = decode(z.array(IssueUser).max(100), (await this.#get(`users?username=${encodeURIComponent(username)}`, signal, budget)).body);
    const user = users.find(user => user.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new ForgeError("not_found");
    return user.id;
  }
  async writeIssue(input: ForgeIssueWrite, actionId: string, signal: AbortSignal, dispatch?: WriteDispatch) {
    const value = ForgeIssueWrite.parse(input);
    z.string().min(1).max(256).parse(actionId);
    const budget = new ReadBudget();
    const marker = markerFor(actionId);
    if (value.action === "create") {
      if (!this.#enabled(await this.#project(signal, budget))) throw new ForgeError("forbidden");
      const record = decode(Issue, (await this.#api.request(`${this.#root}/issues`, signal, budget,
        { title: value.title, description: `${value.body}\n\n${marker}` }, "POST", dispatch)).body);
      return issueRow(this.#repository, record).ref;
    }
    const current = await this.issueDetail(value.number, signal);
    const path = `${this.#root}/issues/${value.number}`;
    if (value.action === "comment") {
      if (!current.permissions.comment) throw new ForgeError("forbidden");
      decode(Note, (await this.#api.request(`${path}/notes`, signal, budget,
        { body: `${value.body}\n\n${marker}` }, "POST", dispatch)).body);
      return current.ref;
    }
    if (value.action === "state" && value.reason !== undefined) throw new ForgeError("unsupported");
    const plan = planIssueWrite(current, value);
    if (plan.kind === "conflict" || plan.kind === "forbidden") throw new ForgeError(plan.kind);
    if (plan.kind === "done") return current.ref;
    let body: Record<string, unknown> = {};
    if (plan.kind === "members") {
      if (plan.field === "labels") {
        if ([...plan.add, ...plan.remove].some(name => name.includes(","))) throw new ForgeError("unsupported");
        body = { add_labels: plan.add.join(","), remove_labels: plan.remove.join(",") };
      } else {
        const names = applyMembers(current.assignees, plan.add, plan.remove);
        const ids: number[] = [];
        for (const name of names) ids.push(await this.#userId(name, signal, budget));
        body = { assignee_ids: ids.length ? ids : [0] };
      }
    } else if (value.action === "state") body = { state_event: value.state === "open" ? "reopen" : "close" };
    else if (value.action === "milestone") body = { milestone_id: value.milestone ?? 0 };
    else {
      body = { ...plan.body };
      if ("body" in body) { body.description = body.body; delete body.body; }
    }
    const record = decode(Issue, (await this.#api.request(path, signal, budget, body, "PUT", dispatch)).body);
    if (record.iid !== value.number) throw new ForgeError("invalid_data");
    return current.ref;
  }
  async reconcileIssue(input: ForgeIssueWrite, actionId: string, signal: AbortSignal) {
    const value = ForgeIssueWrite.parse(input);
    if (value.action !== "create" && value.action !== "comment") {
      const current = await this.issueDetail(value.number, signal);
      return issueWriteLanded(current, value) ? current.ref : null;
    }
    const budget = new ReadBudget();
    for (let page = 1; page <= 10; page++) {
      const path = value.action === "create" ? `${this.#root}/issues?scope=all&state=all&order_by=created_at&sort=desc&per_page=100&page=${page}`
        : `${this.#root}/issues/${value.number}/notes?per_page=100&page=${page}&sort=desc&order_by=created_at`;
      const response = await this.#get(path, signal, budget);
      const records = decode(z.array(z.looseObject({ iid: z.number().int().positive().optional(), description: z.string().nullable().optional(), body: z.string().optional() })).max(100), response.body);
      const found = records.find(record => (value.action === "create" ? record.description : record.body)?.includes(markerFor(actionId)));
      const number = value.action === "comment" ? value.number : found?.iid;
      if (found && number) return { repository: this.#repository, number };
      if (!morePages(response.headers, page, 100, records.length)) return null;
    }
    // A bounded search cannot prove absence. Preserve the journal's uncertainty fence.
    throw new ForgeError("limit");
  }
}
