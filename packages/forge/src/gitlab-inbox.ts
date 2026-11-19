import { z } from "zod";
import { ForgeRepository } from "@ace/protocol/forge";
import {
  ForgeInboxQuery,
  ForgeInboxWrite,
  ForgeInboxList,
  ForgeInboxRow,
} from "@ace/protocol/forge-inbox";
import { GitLabApi, gitLabProjectPath } from "./gitlab-api.ts";
import { ForgeError } from "./errors.ts";
import { ForgeMutationOutcome } from "./mutation.ts";
import { ReadBudget } from "./read-budget.ts";
import type { HostApiWrite } from "./read-only-api.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
import { pollSeconds } from "./inbox-rows.ts";

export const gitLabInboxWrites: readonly HostApiWrite[] = [
  { method: "POST", endpoint: /^todos\/[1-9]\d*\/mark_as_done$/ },
];
export const GitLabTodo = z.looseObject({
  id: z.number().int().positive(),
  project: z.looseObject({ id: z.number().int().positive(), path_with_namespace: z.string() }),
  action_name: z.string(),
  target_type: z.string(),
  target: z
    .looseObject({
      iid: z.number().int().positive().optional(),
      title: z.string().optional(),
      state: z.string().optional(),
      draft: z.boolean().optional(),
    })
    .nullable(),
  body: z.string(),
  state: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
});
const Todos = z.array(GitLabTodo).max(50);
/** Build canonical links locally; target_url from the server is never trusted. */
export function gitLabTodoRow(host: string, todo: z.infer<typeof GitLabTodo>): ForgeInboxRow {
  const slash = todo.project.path_with_namespace.lastIndexOf("/");
  if (slash <= 0) throw new ForgeError("invalid_data");
  const repository = ForgeRepository.parse({
    forge: "gitlab",
    host,
    owner: todo.project.path_with_namespace.slice(0, slash),
    name: todo.project.path_with_namespace.slice(slash + 1),
  });
  const type = todo.target_type === "MergeRequest" ? "PullRequest" : todo.target_type;
  const number = type === "PullRequest" || type === "Issue" ? todo.target?.iid : undefined;
  const root = `https://${host}/${repository.owner}/${repository.name}`;
  const rawState = todo.target?.state;
  const state =
    rawState === "opened"
      ? todo.target?.draft
        ? "draft"
        : "open"
      : rawState === "merged"
        ? "merged"
        : rawState === "closed"
          ? "closed"
          : undefined;
  return ForgeInboxRow.parse({
    id: String(todo.id),
    repository,
    type,
    title: todo.target?.title ?? todo.body,
    ...(number ? { number } : {}),
    ...(state ? { state } : {}),
    reason: inboxReason(todo.action_name),
    unread: todo.state === "pending",
    updatedAt: todo.updated_at ?? todo.created_at,
    lastReadAt: null,
    url: number
      ? `${root}/-/${type === "PullRequest" ? "merge_requests" : "issues"}/${number}`
      : root,
  });
}
/**
 * GitLab's to-do actions (docs.gitlab.com/api/todos/) as the inbox's shared reasons, the ones
 * GitHub's notifications use, so one filter finds both. An action with no equivalent is kept
 * as GitLab named it.
 */
const reasons: Record<string, string> = {
  assigned: "assign",
  mentioned: "mention",
  directly_addressed: "mention",
  review_requested: "review_requested",
  approval_required: "review_requested",
  build_failed: "ci_activity",
  marked: "manual",
  unmergeable: "state_change",
  merge_train_removed: "state_change",
};
export function inboxReason(action: string): string {
  return reasons[action] ?? action;
}
const ProjectId = z.looseObject({ id: z.number().int().positive() });

/** Account-local to-dos. Construct anew when the source-control identity changes. */
export class GitLabInbox {
  readonly host: string;
  readonly #api: GitLabApi;
  constructor(api: GitLabApi) {
    this.#api = api;
    this.host = api.repository.host;
  }
  async list(input: ForgeInboxQuery, signal: AbortSignal): Promise<ForgeInboxList> {
    const query = ForgeInboxQuery.parse(input);
    if (query.participating || query.since) throw new ForgeError("unsupported");
    if (
      query.repository &&
      (query.repository.forge !== "gitlab" || query.repository.host !== this.host)
    )
      throw new ForgeError("unsupported");
    const budget = new ReadBudget();
    const params = new URLSearchParams({ per_page: "50", page: String(query.page) });
    if (!query.all) params.set("state", "pending");
    if (query.repository) {
      const project = ProjectId.safeParse(
        (await this.#api.get(gitLabProjectPath(query.repository), signal, budget)).body,
      );
      if (!project.success) throw new ForgeError("invalid_data");
      params.set("project_id", String(project.data.id));
    }
    const response = await this.#api.get(`todos?${params}`, signal, budget);
    const todos = Todos.safeParse(response.body);
    if (!todos.success) throw new ForgeError("invalid_data");
    const next = response.headers["x-next-page"];
    const more = next === undefined ? todos.data.length === 50 : next.trim() !== "";
    return ForgeInboxList.parse({
      host: this.host,
      items: todos.data.map((todo) => gitLabTodoRow(this.host, todo)),
      ...(more && query.page < 20 ? { nextPage: query.page + 1 } : {}),
      pollSeconds: pollSeconds(response.headers["x-poll-interval"]),
      unchanged: false,
    });
  }
  /** Resolve a to-do's own repository before the daemon admits a write to it. */
  async find(id: string, signal: AbortSignal): Promise<ForgeInboxRow> {
    const budget = new ReadBudget();
    for (let page = 1; page <= 20; page++) {
      const response = await this.#api.get(`todos?per_page=50&page=${page}`, signal, budget);
      const todos = Todos.safeParse(response.body);
      if (!todos.success) throw new ForgeError("invalid_data");
      const found = todos.data.find((todo) => String(todo.id) === id);
      if (found) return gitLabTodoRow(this.host, found);
      const next = response.headers["x-next-page"];
      if (next?.trim() === "" || (next === undefined && todos.data.length < 50))
        throw new ForgeError("not_found");
    }
    throw new ForgeError("limit");
  }
  async write(
    input: ForgeInboxWrite,
    signal: AbortSignal,
    dispatch?: WriteDispatch,
  ): Promise<void> {
    const value = ForgeInboxWrite.parse(input);
    // No read/unsubscribe equivalent, and mark-all-done cannot honor a before cutoff.
    if (value.action !== "done") throw new ForgeError("unsupported", undefined, false);
    const response = await this.#api.write(
      `todos/${value.id}/mark_as_done`,
      "POST",
      {},
      signal,
      new ReadBudget(),
      dispatch,
    );
    const ack = GitLabTodo.safeParse(response.body);
    if (!ack.success || String(ack.data.id) !== value.id || ack.data.state !== "done")
      throw new ForgeMutationOutcome({ dispatched: true });
  }
}
