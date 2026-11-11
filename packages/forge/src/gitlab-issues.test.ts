// Hand-made `glab api --include` replies shaped after docs.gitlab.com/api/issues/,
// docs.gitlab.com/api/notes/ and docs.gitlab.com/api/users/; no account, no quota.
import { expect, test } from "vitest";
import { ForgeIssueSearch, type ForgeIssueWrite } from "@ace/protocol/forge-issues";
import type { CommandRequest, CommandRunner } from "./command.ts";
import { gitlabIssueWrites } from "./gitlab-issue-writes.ts";
import { GitLabIssues } from "./gitlab-issues.ts";
import { issueFromUrl } from "./pr-reference.ts";
import { isAdmittedApiRequest, isAdmittedWriteRequest } from "./read-only-api.ts";
import { WriteDispatch } from "./write-dispatch.ts";

const repository = {
  forge: "gitlab",
  host: "gitlab.com",
  owner: "group/sub",
  name: "repo",
} as const;
const root = "projects/group%2Fsub%2Frepo";
const sam = { id: 1, username: "sam", avatar_url: "https://gitlab.com/a.png" };
const lee = { id: 2, username: "lee.k" };
const issue = {
  id: 9001,
  iid: 7,
  title: "Bug",
  description: "Details",
  author: sam,
  state: "opened",
  labels: ["bug"],
  assignees: [sam],
  milestone: { id: 8, iid: 1, title: "v1" },
  confidential: true,
  discussion_locked: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  user_notes_count: 3,
  future_field: { kept: true },
};
const signal = new AbortController().signal;

type Reply = { code: number; stdout: string; truncated: boolean };
function reply(body: unknown, headers: Record<string, string> = {}, status = 200): Reply {
  const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`);
  return {
    code: status < 400 ? 0 : 1,
    stdout: `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n${lines.join("")}\r\n${JSON.stringify(body)}`,
    truncated: false,
  };
}

/** A glab stand-in that refuses anything the write identity wouldn't admit. */
function gitlab(
  options: {
    access?: number;
    viewer?: typeof sam;
    handle?: (path: string, request: CommandRequest) => Reply | undefined;
  } = {},
) {
  const writes: { args: readonly string[]; body: unknown }[] = [];
  const reads: string[] = [];
  const runner: CommandRunner = async (request) => {
    if (!isAdmittedApiRequest("glab", request, "gitlab.com", gitlabIssueWrites(repository)))
      throw new Error(`not admitted: ${request.args.join(" ")}`);
    const path = request.args[1] ?? "";
    if (request.input !== undefined) {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push({ args: request.args, body: JSON.parse(request.input) });
    } else reads.push(path);
    const custom = options.handle?.(path, request);
    if (custom) return custom;
    if (path === "user") return reply(options.viewer ?? sam);
    if (path === root)
      return reply({
        id: 3,
        archived: false,
        issues_enabled: true,
        permissions: { project_access: { access_level: options.access ?? 30 }, group_access: null },
      });
    if (path.startsWith("users?")) return reply(path.includes("lee.k") ? [lee] : []);
    if (path.endsWith("/notes"))
      return reply({ id: 30, body: "Hi", author: sam, system: false, created_at: "x" }, {}, 201);
    if (path.startsWith(`${root}/issues?`))
      return reply([issue], { "x-total": "1", "x-next-page": "" });
    return reply(issue);
  };
  return { issues: new GitLabIssues({ repository, runner }), writes, reads };
}

test("a list sends GitLab's filters, counts both states by x-total and keeps unknown fields", async () => {
  const seen: URLSearchParams[] = [];
  const { issues } = gitlab({
    handle: (path) => {
      if (!path.startsWith(`${root}/issues?`)) return undefined;
      const params = new URLSearchParams(path.split("?")[1]);
      seen.push(params);
      const labelled = { ...issue, labels: [{ name: "bug", color: "#dc143c" }] };
      if (params.get("state") === "closed") return reply([issue], { "x-total": "9" });
      return reply([labelled], { "x-total": "51", "x-next-page": "3" });
    },
  });
  const query = ForgeIssueSearch.parse({
    author: "@me",
    assignee: "lee.k",
    labels: ["bug", "urgent"],
    milestone: "v1",
    search: " crash ",
    sort: "created",
    order: "asc",
    page: 2,
  });
  const list = await issues.listIssues(query, signal);
  const page = seen.find((params) => params.get("state") === "opened");
  expect(Object.fromEntries(page ?? [])).toEqual({
    scope: "all",
    order_by: "created_at",
    sort: "asc",
    search: "crash",
    labels: "bug,urgent",
    milestone: "v1",
    author_username: "sam",
    assignee_username: "lee.k",
    state: "opened",
    per_page: "25",
    page: "2",
    with_labels_details: "true",
  });
  expect(list).toMatchObject({
    viewer: "sam",
    total: 51,
    counts: { open: 51, closed: 9 },
    nextPage: 3,
    canCreate: true,
    incomplete: false,
    truncated: false,
    items: [
      {
        ref: { repository, number: 7 },
        state: "open",
        url: "https://gitlab.com/group/sub/repo/-/issues/7",
        labels: ["bug"],
        labelColors: { bug: "dc143c" },
        assignees: ["sam"],
        milestone: "v1",
        commentCount: 3,
        raw: { future_field: { kept: true } },
      },
    ],
  });
});

test.each([
  [
    "no x-total past 10,000 rows",
    1,
    {},
    { total: 1, nextPage: undefined, incomplete: true, truncated: false },
  ],
  [
    "more than 1,000 rows",
    1,
    { "x-total": "1001", "x-next-page": "2" },
    { total: 1001, nextPage: 2, incomplete: false, truncated: true },
  ],
  [
    "the last page ace lists",
    40,
    { "x-total": "1001", "x-next-page": "41" },
    { total: 1001, nextPage: undefined, incomplete: false, truncated: true },
  ],
])("a list with %s says so honestly", async (_name, page, headers, expected) => {
  const { issues } = gitlab({
    handle: (path) => (path.startsWith(`${root}/issues?`) ? reply([issue], headers) : undefined),
  });
  const { total, nextPage, incomplete, truncated } = await issues.listIssues(
    ForgeIssueSearch.parse({ page }),
    signal,
  );
  expect({ total, nextPage, incomplete, truncated }).toEqual(expected);
});

test("a row in a state GitLab may add later is dropped and the list marked incomplete", async () => {
  const { issues } = gitlab({
    handle: (path) =>
      path.startsWith(`${root}/issues?`)
        ? reply(
            path.includes("per_page=1&") ? [issue] : [issue, { ...issue, iid: 8, state: "locked" }],
            { "x-total": "2" },
          )
        : undefined,
  });
  const list = await issues.listIssues(ForgeIssueSearch.parse({}), signal);
  expect(list.items.map((row) => row.ref.number)).toEqual([7]);
  expect(list.incomplete).toBe(true);
});

test("sorting by comments is refused, since GitLab can't order by them", async () => {
  const { issues, reads } = gitlab();
  await expect(
    issues.listIssues(ForgeIssueSearch.parse({ sort: "comments" }), signal),
  ).rejects.toMatchObject({ kind: "unsupported" });
  expect(reads).toEqual([]);
});

test("detail maps the description, confidentiality and milestone id without a close reason", async () => {
  const { issues } = gitlab({
    handle: (path) =>
      path === `${root}/issues/7` ? reply({ ...issue, state: "closed" }) : undefined,
  });
  const detail = await issues.issueDetail(7, signal);
  expect(detail).toMatchObject({
    body: "Details",
    state: "closed",
    author: "sam",
    confidential: true,
    milestone: "v1",
    milestoneNumber: 8,
    permissions: { edit: true, close: true, reopen: true, comment: true, triage: true },
  });
  expect(detail.stateReason).toBeUndefined();
});

test.each([
  ["a guest who didn't write it", 10, lee, { edit: false, triage: false, comment: true }],
  ["its guest author", 10, sam, { edit: true, triage: false, comment: true }],
  ["a planner", 15, lee, { edit: true, triage: true, comment: true }],
])("detail permissions for %s follow GitLab's roles", async (_name, access, viewer, expected) => {
  const { issues } = gitlab({ access, viewer: { ...viewer, avatar_url: "" } });
  expect((await issues.issueDetail(7, signal)).permissions).toMatchObject(expected);
});

const locked = (path: string) =>
  path === `${root}/issues/7` ? reply({ ...issue, discussion_locked: true }) : undefined;
test("a locked discussion admits comments only from members who can triage", async () => {
  expect(
    (await gitlab({ access: 10, handle: locked }).issues.issueDetail(7, signal)).permissions
      .comment,
  ).toBe(false);
  expect(
    (await gitlab({ access: 30, handle: locked }).issues.issueDetail(7, signal)).permissions
      .comment,
  ).toBe(true);
});

test("the timeline shows user notes as comments and system notes as activity, linking named MRs", async () => {
  const { issues } = gitlab({
    handle: (path) =>
      path.startsWith(`${root}/issues/7/notes?`)
        ? reply(
            [
              {
                id: 2,
                body: "mentioned in merge request !12",
                author: sam,
                created_at: "a",
                system: true,
                future: 9,
              },
              {
                id: 3,
                body: "mentioned in merge request other/proj!4",
                author: sam,
                created_at: "b",
                system: true,
              },
              {
                id: 4,
                body: "marked this issue as related to #3",
                author: sam,
                created_at: "c",
                system: true,
              },
              { id: 5, body: "See !12", author: lee, created_at: "d", system: false },
            ],
            { "x-total": "3020", "x-next-page": "121" },
          )
        : undefined,
  });
  const timeline = await issues.issueTimeline(7, 120, signal);
  expect(timeline).toMatchObject({ truncated: true, lastPage: 120 });
  expect(timeline.nextPage).toBeUndefined();
  expect(
    timeline.events.map(({ kind, actor, body, pullRequestUrl, url }) => ({
      kind,
      actor,
      body,
      pullRequestUrl,
      url,
    })),
  ).toEqual([
    {
      kind: "activity",
      actor: "sam",
      body: "mentioned in merge request !12",
      pullRequestUrl: "https://gitlab.com/group/sub/repo/-/merge_requests/12",
      url: "https://gitlab.com/group/sub/repo/-/issues/7#note_2",
    },
    {
      kind: "activity",
      actor: "sam",
      body: "mentioned in merge request other/proj!4",
      pullRequestUrl: "https://gitlab.com/other/proj/-/merge_requests/4",
      url: "https://gitlab.com/group/sub/repo/-/issues/7#note_3",
    },
    {
      kind: "activity",
      actor: "sam",
      body: "marked this issue as related to #3",
      pullRequestUrl: undefined,
      url: "https://gitlab.com/group/sub/repo/-/issues/7#note_4",
    },
    {
      kind: "issue_comment",
      actor: "lee.k",
      body: "See !12",
      pullRequestUrl: undefined,
      url: "https://gitlab.com/group/sub/repo/-/issues/7#note_5",
    },
  ]);
  expect(timeline.events[0]?.raw).toMatchObject({ future: 9 });
});

const exact = (method: string, endpoint: string) => [
  "api",
  endpoint,
  "-X",
  method,
  "--hostname",
  "gitlab.com",
  "--include",
  "--input",
  "-",
];
const marked = (text: string) => `${text}\n\n<!-- ace-issue-action:a%2F1 -->`;
const writes: [string, ForgeIssueWrite, string, string, unknown][] = [
  [
    "create",
    { action: "create", title: "New", body: "Draft" },
    "POST",
    `${root}/issues`,
    { title: "New", description: marked("Draft") },
  ],
  [
    "comment",
    { action: "comment", number: 7, body: "Hi" },
    "POST",
    `${root}/issues/7/notes`,
    { body: marked("Hi") },
  ],
  [
    "edit",
    {
      action: "edit",
      number: 7,
      expectedUpdatedAt: issue.updated_at,
      title: "Fixed",
      body: "More",
    },
    "PUT",
    `${root}/issues/7`,
    { title: "Fixed", description: "More" },
  ],
  [
    "edit one field of a base",
    {
      action: "edit",
      number: 7,
      expectedUpdatedAt: "old",
      title: "Bug",
      body: "More",
      base: { title: "Bug", body: "Details" },
    },
    "PUT",
    `${root}/issues/7`,
    { description: "More" },
  ],
  [
    "close",
    { action: "state", number: 7, expectedUpdatedAt: "", state: "closed" },
    "PUT",
    `${root}/issues/7`,
    { state_event: "close" },
  ],
  [
    "close as completed",
    { action: "state", number: 7, expectedUpdatedAt: "", state: "closed", reason: "completed" },
    "PUT",
    `${root}/issues/7`,
    { state_event: "close" },
  ],
  [
    "labels",
    { action: "labels", number: 7, add: ["urgent"], remove: ["BUG"] },
    "PUT",
    `${root}/issues/7`,
    { add_labels: "urgent", remove_labels: "bug" },
  ],
  [
    "add an assignee",
    { action: "assignees", number: 7, add: ["lee.k"], remove: [] },
    "PUT",
    `${root}/issues/7`,
    { assignee_ids: [1, 2] },
  ],
  [
    "remove every assignee",
    { action: "assignees", number: 7, add: [], remove: ["sam"] },
    "PUT",
    `${root}/issues/7`,
    { assignee_ids: [0] },
  ],
  [
    "set the milestone",
    { action: "milestone", number: 7, milestone: 9 },
    "PUT",
    `${root}/issues/7`,
    { milestone_id: 9 },
  ],
  [
    "clear the milestone",
    { action: "milestone", number: 7, milestone: null },
    "PUT",
    `${root}/issues/7`,
    { milestone_id: 0 },
  ],
];
test.each(writes)(
  "%s sends exactly one admitted write",
  async (_name, input, method, endpoint, body) => {
    const { issues, writes: sent } = gitlab();
    expect(await issues.writeIssue(input, "a/1", signal)).toEqual({ repository, number: 7 });
    expect(sent).toEqual([{ args: exact(method, endpoint), body }]);
  },
);

test("reopening sends state_event reopen", async () => {
  const { issues, writes: sent } = gitlab({
    handle: (path, request) =>
      path === `${root}/issues/7` && !request.input
        ? reply({ ...issue, state: "closed" })
        : undefined,
  });
  await issues.writeIssue(
    { action: "state", number: 7, state: "open", expectedUpdatedAt: "" },
    "id",
    signal,
  );
  expect(sent.map((write) => write.body)).toEqual([{ state_event: "reopen" }]);
});

test.each([
  [
    "closing as not planned, which GitLab can't record",
    { action: "state", number: 7, expectedUpdatedAt: "", state: "closed", reason: "not_planned" },
    "unsupported",
  ],
  [
    "a stale edit",
    { action: "edit", number: 7, title: "x", body: "y", expectedUpdatedAt: "stale" },
    "conflict",
  ],
  [
    "a label with a comma",
    { action: "labels", number: 7, add: ["a,b"], remove: [] },
    "unsupported",
  ],
  [
    "an unknown assignee",
    { action: "assignees", number: 7, add: ["nobody"], remove: [] },
    "not_found",
  ],
] as [string, ForgeIssueWrite, string][])(
  "%s is refused before anything is sent",
  async (_name, input, kind) => {
    const { issues, writes: sent } = gitlab();
    const dispatch = new WriteDispatch();
    await expect(issues.writeIssue(input, "id", signal, dispatch)).rejects.toMatchObject({ kind });
    expect(sent).toEqual([]);
    expect(dispatch.definitelyFailed).toBe(true);
  },
);

test("a write that changes nothing sends nothing", async () => {
  const { issues, writes: sent } = gitlab();
  await issues.writeIssue({ action: "labels", number: 7, add: ["BUG"], remove: [] }, "id", signal);
  await issues.writeIssue({ action: "milestone", number: 7, milestone: 8 }, "id", signal);
  expect(sent).toEqual([]);
});

test("a write GitLab refuses has definitely failed; one whose answer was lost is uncertain", async () => {
  for (const [status, failed, kind] of [
    [422, true, "unprocessable"],
    [500, false, "outcome_uncertain"],
  ] as const) {
    const { issues } = gitlab({
      handle: (_path, request) => (request.input ? reply({ message: "x" }, {}, status) : undefined),
    });
    const dispatch = new WriteDispatch();
    await expect(
      issues.writeIssue({ action: "create", title: "New", body: "Draft" }, "id", signal, dispatch),
    ).rejects.toMatchObject({ kind });
    expect(dispatch.definitelyFailed).toBe(failed);
  }
});

test("recovery finds a lost create or comment by its marker without writing again", async () => {
  let landed = true;
  const { issues, writes: sent } = gitlab({
    handle: (path) => {
      if (path.startsWith(`${root}/issues?`))
        return reply(landed ? [{ ...issue, iid: 12, description: marked("Draft") }] : [issue], {
          "x-next-page": "",
        });
      if (path.startsWith(`${root}/issues/7/notes?`))
        return reply(landed ? [{ id: 3, body: marked("Hi"), system: false }] : [], {
          "x-next-page": "",
        });
      return undefined;
    },
  });
  const create = { action: "create", title: "New", body: "Draft" } as const;
  const comment = { action: "comment", number: 7, body: "Hi" } as const;
  expect(await issues.reconcileIssue(create, "a/1", signal)).toEqual({ repository, number: 12 });
  expect(await issues.reconcileIssue(comment, "a/1", signal)).toEqual({ repository, number: 7 });
  landed = false;
  expect(await issues.reconcileIssue(create, "a/1", signal)).toBeNull();
  expect(await issues.reconcileIssue(comment, "a/1", signal)).toBeNull();
  expect(
    await issues.reconcileIssue(
      { action: "state", number: 7, expectedUpdatedAt: "", state: "closed", reason: "completed" },
      "a/1",
      signal,
    ),
  ).toBeNull();
  expect(sent).toEqual([]);
});

const admitted = (args: string[], input = "{}") =>
  isAdmittedWriteRequest(
    "glab",
    { command: "glab", args, input },
    "gitlab.com",
    gitlabIssueWrites(repository),
  );
test("only the three issue writes are admitted, in their one exact shape", () => {
  expect(admitted(exact("POST", `${root}/issues`))).toBe(true);
  expect(admitted(exact("POST", `${root}/issues/7/notes`))).toBe(true);
  expect(admitted(exact("PUT", `${root}/issues/7`))).toBe(true);
  for (const args of [
    exact("PUT", `${root}/merge_requests/7`),
    exact("POST", `${root}/merge_requests/7/notes`),
    exact("DELETE", `${root}/issues/7`),
    exact("PUT", `${root}/issues`),
    exact("POST", `${root}/issues/7`),
    exact("PUT", `${root}/issues/7?state_event=close`),
    exact("PUT", `${root}/issues/7/notes/3`),
    exact("POST", `projects/a/b/issues`),
    exact("PUT", `${root}/issues/0`),
    [
      "api",
      `${root}/issues/7`,
      "-X",
      "PUT",
      "--hostname",
      "evil.test",
      "--include",
      "--input",
      "-",
    ],
    [...exact("PUT", `${root}/issues/7`), "--paginate"],
    [
      "api",
      `${root}/issues/7`,
      "-X",
      "PUT",
      "--hostname",
      "gitlab.com",
      "--input",
      "-",
      "--include",
    ],
    ["api", `${root}/issues/7`, "-X", "PUT", "--hostname", "gitlab.com", "--include", "-f", "a=b"],
  ])
    expect(admitted(args), args.join(" ")).toBe(false);
  expect(admitted(exact("PUT", `${root}/issues/7`), "[]")).toBe(false);
  expect(admitted(exact("PUT", `${root}/issues/7`), "not json")).toBe(false);
});

test("GitLab issue addresses keep nested groups; other hosts, ports and credentials are refused", () => {
  expect(issueFromUrl("https://gitlab.com/group/sub/repo/-/issues/7")).toEqual({
    repository,
    number: 7,
  });
  expect(issueFromUrl("https://github.com/o/r/issues/3")).toMatchObject({
    repository: { forge: "github" },
    number: 3,
  });
  for (const url of [
    "https://evil.test/group/repo/-/issues/7",
    "http://gitlab.com/group/repo/-/issues/7",
    "https://user:secret@gitlab.com/group/repo/-/issues/7",
    "https://gitlab.com:8443/group/repo/-/issues/7",
    "https://github.com/o/r/-/issues/7",
  ])
    expect(() => issueFromUrl(url), url).toThrow();
});
