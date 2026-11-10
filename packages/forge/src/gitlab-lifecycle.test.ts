import { expect, test } from "vitest";
import { GitLabApi } from "./gitlab-api.ts";
import { GitLabLifecycle, gitLabLifecycleWrites } from "./gitlab-lifecycle.ts";
import { MutationDispatch } from "./mutation.ts";
import { isAdmittedWriteRequest } from "./read-only-api.ts";
import type { CommandRequest, CommandRunner } from "./command.ts";
import type { ForgeLifecycleAction } from "@ace/protocol/forge-lifecycle";
const repository = { forge: "gitlab" as const, host: "gitlab.com", owner: "team", name: "repo" };
const sha = "a".repeat(40);
const signal = new AbortController().signal;
function fixture(options: { role?: number; identityChanged?: true; lost?: boolean } = {}) {
  let mr = {
    id: 70,
    iid: 7,
    title: "Change",
    description: "Before",
    state: "opened",
    draft: false,
    updated_at: "2026-11-01T00:00:00Z",
    sha,
    diff_refs: { head_sha: sha, base_sha: "b".repeat(40) },
    target_branch: "main",
    labels: ["old"],
    assignees: [],
    discussion_locked: false,
  };
  const writes: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    let body: unknown;
    if (request.input !== undefined) {
      expect(isAdmittedWriteRequest("glab", request, repository.host, gitLabLifecycleWrites)).toBe(
        true,
      );
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push(request);
      const value = JSON.parse(request.input);
      mr = {
        ...mr,
        ...value,
        title: value.title ?? mr.title,
        description: value.description ?? mr.description,
        labels:
          value.labels === undefined ? mr.labels : value.labels ? value.labels.split(",") : [],
        state:
          value.state_event === "close"
            ? "closed"
            : value.state_event === "reopen"
              ? "opened"
              : mr.state,
        draft: (value.title ?? mr.title).startsWith("Draft:"),
      };
      if (options.lost) throw new Error("lost reply");
      body = mr;
    } else
      body = request.args[1]?.endsWith("/merge_requests/7")
        ? mr
        : {
            archived: false,
            permissions: { project_access: { access_level: options.role ?? 30 } },
          };
    return {
      code: 0,
      stdout: `HTTP/2 200 OK\n\n${JSON.stringify(body)}`,
      truncated: false,
      ...(request.input !== undefined && options.identityChanged ? { identityChanged: true } : {}),
    };
  };
  return { backend: new GitLabLifecycle(new GitLabApi({ repository, runner })), writes };
}
for (const action of [
  { kind: "edit", changes: { title: "Better", body: "After", labels: ["new"] } },
  { kind: "close" },
  { kind: "draft" },
] satisfies ForgeLifecycleAction[]) {
  test(`GitLab lifecycle ${action.kind} sends only the admitted update and observes the result`, async () => {
    const f = fixture();
    const before = await f.backend.snapshot(7, signal);
    expect(
      await f.backend.apply(
        7,
        before.version,
        action,
        "operation",
        signal,
        () => true,
        new MutationDispatch(),
      ),
    ).toMatchObject({ outcome: "accepted", headSha: sha });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.args).toEqual([
      "api",
      "projects/team%2Frepo/merge_requests/7",
      "-X",
      "PUT",
      "--hostname",
      "gitlab.com",
      "--include",
      "--input",
      "-",
    ]);
    expect(JSON.parse(f.writes[0]?.input ?? "null")).toEqual(
      action.kind === "close"
        ? { state_event: "close" }
        : action.kind === "draft"
          ? { title: "Draft: Change" }
          : { title: "Better", description: "After", labels: "new" },
    );
  });
}
test("GitLab lifecycle reopens a closed request and removes its draft title", async () => {
  const f = fixture();
  const apply = async (action: ForgeLifecycleAction) => {
    const before = await f.backend.snapshot(7, signal);
    return f.backend.apply(
      7,
      before.version,
      action,
      "op",
      signal,
      () => true,
      new MutationDispatch(),
    );
  };
  await apply({ kind: "close" });
  await apply({ kind: "reopen" });
  await apply({ kind: "draft" });
  await apply({ kind: "ready" });
  expect(await f.backend.snapshot(7, signal)).toMatchObject({
    state: "open",
    metadata: { title: "Change" },
  });
  expect(f.writes.map((request) => JSON.parse(request.input ?? "null"))).toEqual([
    { state_event: "close" },
    { state_event: "reopen" },
    { title: "Draft: Change" },
    { title: "Change" },
  ]);
});
test("stale snapshots and readers without edit permission never dispatch", async () => {
  const f = fixture({ role: 20 });
  const before = await f.backend.snapshot(7, signal);
  await expect(
    f.backend.apply(
      7,
      before.version,
      { kind: "close" },
      "op",
      signal,
      () => true,
      new MutationDispatch(),
    ),
  ).rejects.toBeDefined();
  expect(f.writes).toEqual([]);
  const editor = fixture();
  await expect(
    editor.backend.apply(
      7,
      "stale",
      { kind: "close" },
      "op",
      signal,
      () => true,
      new MutationDispatch(),
    ),
  ).rejects.toBeDefined();
  expect(editor.writes).toEqual([]);
});
test("a differently identified lifecycle acknowledgement remains uncertain", async () => {
  const f = fixture({ identityChanged: true });
  const before = await f.backend.snapshot(7, signal);
  await expect(
    f.backend.apply(
      7,
      before.version,
      { kind: "close" },
      "op",
      signal,
      () => true,
      new MutationDispatch(),
    ),
  ).rejects.toMatchObject({ kind: "outcome_uncertain" });
});
test("a lost lifecycle acknowledgement can be observed without repeating it", async () => {
  const f = fixture({ lost: true });
  const before = await f.backend.snapshot(7, signal);
  await expect(
    f.backend.apply(
      7,
      before.version,
      { kind: "close" },
      "op",
      signal,
      () => true,
      new MutationDispatch(),
    ),
  ).rejects.toBeDefined();
  expect(await f.backend.observe(7, { kind: "close" }, before, "op", signal)).toMatchObject({
    outcome: "accepted",
  });
  expect(f.writes).toHaveLength(1);
});
