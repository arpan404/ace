import { expect, test } from "vitest";
import { TeaIssueWriter, teaIssueWrites } from "./tea-issue-writes.ts";
import { isAdmittedApiRequest } from "./read-only-api.ts";
import type { CommandRequest } from "./command.ts";
const signal = new AbortController().signal;
const issue = {
  number: 3,
  title: "Bug",
  body: "Before",
  state: "open",
  user: { login: "alice" },
  created_at: "2026-01-01",
  updated_at: "2026-01-02",
  labels: [{ name: "old" }],
  assignees: [{ login: "alice" }],
};
for (const forge of ["gitea", "forgejo"] as const) {
  const repository = { forge, host: "git.example", owner: "team", name: "app" };
  function fixture(respond?: (request: CommandRequest) => unknown) {
    const writes: { method: string | undefined; path: string | undefined; body: unknown }[] = [];
    const writer = new TeaIssueWriter({
      repository,
      login: "work",
      runner: async (r) => {
        expect(isAdmittedApiRequest("tea", r, "work", teaIssueWrites)).toBe(true);
        if (r.input) writes.push({ method: r.args[3], path: r.args[1], body: JSON.parse(r.input) });
        const body = respond
          ? respond(r)
          : r.args[1] === "repos/team/app"
            ? { archived: false, has_issues: true, permissions: { push: true } }
            : r.args[1]?.includes("/labels?")
              ? [
                  { id: 1, name: "old" },
                  { id: 2, name: "new" },
                ]
              : r.input
                ? { ...issue, id: 12 }
                : issue;
        return {
          code: 0,
          stdout: JSON.stringify(body),
          truncated: false,
          http: { status: 200, headers: { "x-total-count": "2" } },
        };
      },
    });
    return { writer, writes };
  }
  test(`${forge} creates and comments with a recovery marker only in stdin`, async () => {
    const { writer, writes } = fixture();
    expect(
      await writer.writeIssue(
        { action: "create", title: "Bug", body: "Text" },
        "operation",
        signal,
      ),
    ).toEqual({ repository, number: 3 });
    await writer.writeIssue({ action: "comment", number: 3, body: "Reply" }, "comment", signal);
    expect(writes.map((w) => w.body)).toEqual([
      { title: "Bug", body: "Text\n\n<!-- ace-issue-action:operation -->" },
      { body: "Reply\n\n<!-- ace-issue-action:comment -->" },
    ]);
  });
  test(`${forge} edits only after checking the current issue and refuses conflicts`, async () => {
    const { writer, writes } = fixture();
    await writer.writeIssue(
      {
        action: "edit",
        number: 3,
        title: "Fixed",
        body: "After",
        expectedUpdatedAt: issue.updated_at,
      },
      "edit",
      signal,
    );
    expect(writes).toMatchObject([{ method: "PATCH", body: { title: "Fixed", body: "After" } }]);
    await expect(
      writer.writeIssue(
        { action: "edit", number: 3, title: "Other", body: "After", expectedUpdatedAt: "stale" },
        "conflict",
        signal,
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(writes).toHaveLength(1);
  });
  test(`${forge} maps label ids and updates assignees and state`, async () => {
    const { writer, writes } = fixture();
    await writer.writeIssue(
      { action: "labels", number: 3, add: ["new"], remove: ["old"] },
      "labels",
      signal,
    );
    await writer.writeIssue(
      { action: "assignees", number: 3, add: ["bob"], remove: ["alice"] },
      "assign",
      signal,
    );
    await writer.writeIssue(
      { action: "state", number: 3, state: "closed", expectedUpdatedAt: "" },
      "close",
      signal,
    );
    expect(writes).toMatchObject([
      { method: "POST", path: "repos/team/app/issues/3/labels", body: { labels: [2] } },
      { method: "DELETE", path: "repos/team/app/issues/3/labels/1", body: {} },
      { method: "PATCH", body: { assignees: ["bob"] } },
      { method: "PATCH", body: { state: "closed" } },
    ]);
  });
  test(`${forge} refuses archived repositories before mutation`, async () => {
    const { writer, writes } = fixture(() => ({
      archived: true,
      has_issues: true,
      permissions: { push: true },
    }));
    await expect(
      writer.writeIssue({ action: "create", title: "Bug", body: "Text" }, "blocked", signal),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(writes).toEqual([]);
  });
  test(`${forge} reopens an issue and refuses unknown close reasons`, async () => {
    const { writer, writes } = fixture((r) =>
      r.args[1] === "repos/team/app"
        ? { archived: false, has_issues: true, permissions: { push: true } }
        : { ...issue, state: "closed" },
    );
    await writer.writeIssue(
      { action: "state", number: 3, state: "open", expectedUpdatedAt: "" },
      "reopen",
      signal,
    );
    expect(writes).toMatchObject([{ method: "PATCH", body: { state: "open" } }]);
    await expect(
      writer.writeIssue(
        {
          action: "state",
          number: 3,
          state: "closed",
          reason: "not_planned",
          expectedUpdatedAt: "",
        },
        "reason",
        signal,
      ),
    ).rejects.toMatchObject({ kind: "unsupported" });
  });
  test(`${forge} reconciles marked creation through reads without repeating it`, async () => {
    const { writer, writes } = fixture(() => [
      { ...issue, body: "Text\n\n<!-- ace-issue-action:lost -->" },
    ]);
    expect(
      await writer.reconcileIssue({ action: "create", title: "Bug", body: "Text" }, "lost", signal),
    ).toEqual({ repository, number: 3 });
    expect(writes).toEqual([]);
  });
}
