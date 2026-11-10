import { expect, test } from "vitest";
import { ForgeIssueSearch, type ForgeIssueWrite } from "@ace/protocol/forge-issues";
import { GitLabIssues, gitlabIssueWrites } from "./gitlab-issues.ts";
import { isAdmittedApiRequest, isAdmittedWriteRequest } from "./read-only-api.ts";
import type { CommandRequest, CommandRunner } from "./command.ts";
import { WriteDispatch } from "./write-dispatch.ts";
import { issueFromUrl } from "./pr-reference.ts";
const repository = { forge: "gitlab", host: "gitlab.com", owner: "group/sub", name: "repo" } as const;
const root = "projects/group%2Fsub%2Frepo";
const user = { id: 1, username: "sam" };
const issue = { iid: 7, title: "Bug", description: "Details", author: user,
  state: "opened", labels: ["bug"], assignees: [user], milestone: { id: 8, title: "v1" },
  confidential: true, created_at: "2026-01-01", updated_at: "2026-01-02", user_notes_count: 3, future: { kept: true } };
const project = { archived: false, issues_enabled: true, permissions: { project_access: { access_level: 40 } } };
const signal = new AbortController().signal;
function reply(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return { code: status < 400 ? 0 : 1, stdout: `HTTP/2.0 ${status} OK\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join("")}\r\n${JSON.stringify(body)}`, truncated: false };
}
function fixture(handle?: (request: CommandRequest) => ReturnType<typeof reply> | undefined) {
  const writes: CommandRequest[] = [];
  const reads: string[] = [];
  const runner: CommandRunner = async request => {
    expect(isAdmittedApiRequest("glab", request, repository.host, gitlabIssueWrites)).toBe(true);
    if (request.input !== undefined) {
      request.dispatch?.prepare?.(); request.dispatch?.record(); writes.push(request);
    } else reads.push(request.args[1] ?? "");
    const custom = handle?.(request); if (custom) return custom;
    const path = request.args[1];
    if (path === "user") return reply(user);
    if (path === root) return reply(project);
    if (path?.startsWith("users?username=")) return reply([{ id: 2, username: "lee" }]);
    if (path?.includes("/notes") && request.input) return reply({ id: 30, body: "comment", author: user, created_at: "2026-01-02", system: false });
    if (path?.includes("/issues?")) return reply([issue], { "x-total": "1", "x-next-page": "" });
    return reply(issue);
  };
  return { backend: new GitLabIssues({ repository, runner }), writes, reads };
}

test("list forwards filters, preserves unknown issue data and uses state-specific header counts", async () => {
  const { backend, reads } = fixture(request => {
    const path = request.args[1] ?? "";
    if (!path.includes("/issues?")) return;
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("author_username")).toBe("sam");
    expect(params.get("assignee_username[]")).toBe("lee");
    expect(params.get("labels")).toBe("bug,urgent");
    expect(params.get("milestone")).toBe("v1");
    expect(params.get("search")).toBe("crash");
    expect(params.get("order_by")).toBe("created_at");
    expect(params.get("sort")).toBe("asc");
    return reply([issue], { "x-total": params.get("state") === "opened" ? "51" : "9", "x-next-page": "3" });
  });
  const result = await backend.listIssues(ForgeIssueSearch.parse({ author: "@me", assignee: "lee", labels: ["bug", "urgent"], milestone: "v1", search: "crash", sort: "created", order: "asc", page: 2 }), signal);
  expect(result).toMatchObject({ total: 51, counts: { open: 51, closed: 9 }, nextPage: 3, incomplete: false, truncated: false,
    items: [{ state: "open", ref: { number: 7 }, raw: { future: { kept: true } } }] });
  expect(reads.filter(path => path.includes("per_page=1"))).toHaveLength(1);
});
test.each([
  [{ "x-total": "1001", "x-next-page": "41" }, 40, { total: 1001, incomplete: false, truncated: true }],
  [{}, 1, { total: 1, incomplete: true, truncated: false }],
  [{ "x-total": "nonsense" }, 1, { total: 1, incomplete: true, truncated: false }],
] as const)("list marks missing counts and capped traversals honestly (%j)", async (headers, page, expected) => {
  const { backend } = fixture(request => request.args[1]?.includes("/issues?") ? reply([issue], headers) : undefined);
  const result = await backend.listIssues(ForgeIssueSearch.parse({ page }), signal);
  expect(result).toMatchObject(expected); expect(result.nextPage).toBeUndefined();
});
test("detail maps confidential issues and milestone global ids without inventing a close reason", async () => {
  const { backend } = fixture();
  expect(await backend.issueDetail(7, signal)).toMatchObject({ body: "Details", confidential: true, milestoneNumber: 8,
    permissions: { edit: true, triage: true }, url: "https://gitlab.com/group/sub/repo/-/issues/7" });
});
test("notes distinguish user comments and system activity, retain future data and bound paging", async () => {
  const { backend } = fixture(request => request.args[1]?.includes("/notes?") ? reply([
    { id: 2, body: "changed title", author: user, created_at: "2026-01-01", system: true, future: 9 },
    { id: 3, body: "hello", author: user, created_at: "2026-01-02", system: false },
  ], { "x-total": "3020", "x-next-page": "121" }) : undefined);
  expect(await backend.issueTimeline(7, 120, signal)).toMatchObject({ truncated: true, lastPage: 120,
    events: [{ kind: "activity", body: "changed title", raw: { future: 9 } }, { kind: "issue_comment", body: "hello", url: "https://gitlab.com/group/sub/repo/-/issues/7#note_3" }] });
});
const cases: [ForgeIssueWrite, string, string, unknown][] = [
  [{ action: "create", title: "New", body: "Draft" }, "POST", `${root}/issues`, { title: "New", description: "Draft\n\n<!-- ace-issue-action:id -->" }],
  [{ action: "comment", number: 7, body: "Hi" }, "POST", `${root}/issues/7/notes`, { body: "Hi\n\n<!-- ace-issue-action:id -->" }],
  [{ action: "edit", number: 7, expectedUpdatedAt: "2026-01-02", title: "Fixed", body: "More" }, "PUT", `${root}/issues/7`, { title: "Fixed", description: "More" }],
  [{ action: "state", number: 7, expectedUpdatedAt: "", state: "closed" }, "PUT", `${root}/issues/7`, { state_event: "close" }],
  [{ action: "labels", number: 7, add: ["urgent"], remove: ["bug"] }, "PUT", `${root}/issues/7`, { add_labels: "urgent", remove_labels: "bug" }],
  [{ action: "assignees", number: 7, add: ["lee"], remove: ["sam"] }, "PUT", `${root}/issues/7`, { assignee_ids: [2] }],
  [{ action: "assignees", number: 7, add: [], remove: ["sam"] }, "PUT", `${root}/issues/7`, { assignee_ids: [0] }],
  [{ action: "milestone", number: 7, milestone: 9 }, "PUT", `${root}/issues/7`, { milestone_id: 9 }],
  [{ action: "milestone", number: 7, milestone: null }, "PUT", `${root}/issues/7`, { milestone_id: 0 }],
];
test.each(cases)("%j emits exactly the admitted mutation", async (input, method, path, body) => {
  const { backend, writes } = fixture();
  expect(await backend.writeIssue(input, "id", signal)).toEqual({ repository, number: 7 });
  expect(writes.map(request => ({ args: request.args, input: JSON.parse(request.input ?? "null") }))).toEqual([
    { args: ["api", path, "-X", method, "--hostname", "gitlab.com", "--include", "--input", "-"], input: body },
  ]);
});
test("reopen uses state_event and a stale edit refuses before dispatch", async () => {
  const { backend, writes } = fixture(request => request.args[1] === `${root}/issues/7` && !request.input ? reply({ ...issue, state: "closed" }) : undefined);
  await backend.writeIssue({ action: "state", number: 7, state: "open", expectedUpdatedAt: "" }, "id", signal);
  expect(JSON.parse(writes[0]?.input ?? "null")).toEqual({ state_event: "reopen" });
  await expect(backend.writeIssue({ action: "edit", number: 7, title: "new", body: "new", expectedUpdatedAt: "stale" }, "id", signal)).rejects.toMatchObject({ kind: "conflict" });
  expect(writes).toHaveLength(1);
});
test("lost replies stay uncertain and marker recovery reads without replaying", async () => {
  const { backend, writes } = fixture(request => {
    if (request.input) return reply({}, {}, 500);
    if (request.args[1]?.includes("scope=all&state=all")) return reply([{ ...issue, description: "Draft\n\n<!-- ace-issue-action:id -->" }], { "x-next-page": "" });
  });
  const input = { action: "create", title: "New", body: "Draft" } as const;
  const dispatch = new WriteDispatch();
  await expect(backend.writeIssue(input, "id", signal, dispatch)).rejects.toMatchObject({ kind: "outcome_uncertain" });
  expect(dispatch.definitelyFailed).toBe(false);
  expect(await backend.reconcileIssue(input, "id", signal)).toEqual({ repository, number: 7 });
  expect(writes).toHaveLength(1);
});
test("issue admission refuses other resources, verbs, hosts, query strings and flags", () => {
  for (const args of [
    ["api", `${root}/merge_requests/7`, "-X", "PUT", "--hostname", "gitlab.com", "--include", "--input", "-"],
    ["api", `${root}/issues/7?x=1`, "-X", "PUT", "--hostname", "gitlab.com", "--include", "--input", "-"],
    ["api", `${root}/issues/7`, "-X", "DELETE", "--hostname", "gitlab.com", "--include", "--input", "-"],
    ["api", `${root}/issues/7`, "-X", "PUT", "--hostname", "evil.test", "--include", "--input", "-"],
    ["api", `${root}/issues/7`, "-X", "PUT", "--hostname", "gitlab.com", "--include", "--input", "-", "--paginate"],
  ]) expect(isAdmittedWriteRequest("glab", { command: "glab", args, input: "{}" }, "gitlab.com", gitlabIssueWrites)).toBe(false);
});
test("GitLab issue URLs retain nested project identities and reject unconfigured hosts and credentials", () => {
  expect(issueFromUrl("https://gitlab.com/group/sub/repo/-/issues/7")).toEqual({ repository, number: 7 });
  for (const url of ["https://evil.test/group/repo/-/issues/7", "http://gitlab.com/group/repo/-/issues/7", "https://user:secret@gitlab.com/group/repo/-/issues/7"])
    expect(() => issueFromUrl(url)).toThrow();
});
