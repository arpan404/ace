import { expect, test } from "vitest";
import { GitLabCreation, gitLabCreationWrites } from "./gitlab-creation.ts";
import { isAdmittedWriteRequest } from "./read-only-api.ts";
import type { CommandRequest, CommandRunner } from "./command.ts";
const repository = { forge: "gitlab" as const, host: "gitlab.com", owner: "team", name: "repo" };
const signal = new AbortController().signal;
const target = { id: 1, path_with_namespace: "team/repo", default_branch: "main" };
const fork = {
  id: 2,
  path_with_namespace: "alice/fork",
  default_branch: "main",
  forked_from_project: target,
};
function fixture(options: { unrelated?: boolean; lost?: boolean; switched?: true } = {}) {
  const writes: CommandRequest[] = [];
  let created: object | undefined;
  const runner: CommandRunner = async (request) => {
    const path = request.args[1] ?? "";
    let body: unknown;
    if (request.input !== undefined) {
      expect(isAdmittedWriteRequest("glab", request, repository.host, gitLabCreationWrites)).toBe(
        true,
      );
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push(request);
      const input = JSON.parse(request.input);
      created = {
        iid: 7,
        source_project_id: path.includes("projects/2/") ? 2 : 1,
        target_project_id: 1,
        source_branch: input.source_branch,
        target_branch: input.target_branch,
        state: "opened",
      };
      if (options.lost) throw new Error("lost reply");
      body = created;
    } else if (path === "projects/team%2Frepo") body = target;
    else if (path === "projects/alice%2Ffork")
      body = options.unrelated ? { ...fork, forked_from_project: { ...target, id: 3 } } : fork;
    else if (path.includes("merge_requests?")) body = created ? [created] : [];
    else throw new Error(`unexpected ${path}`);
    return {
      code: 0,
      stdout: `HTTP/2 200 OK\nx-next-page: \n\n${JSON.stringify(body)}`,
      truncated: false,
      ...(request.input !== undefined && options.switched ? { identityChanged: true } : {}),
    };
  };
  return { backend: new GitLabCreation({ repository, runner }), writes };
}
for (const source of [undefined, { owner: "alice", name: "fork" }]) {
  test(`opens a ${source ? "fork" : "same-project"} MR with proven source and target project IDs`, async () => {
    const f = fixture();
    expect(
      await f.backend.openPr(
        { branch: "topic", base: "main", title: "Change", body: "Description", draft: true },
        signal,
        source,
      ),
    ).toEqual({ repository, number: 7 });
    expect(f.writes[0]?.args).toEqual([
      "api",
      `projects/${source ? 2 : 1}/merge_requests`,
      "-X",
      "POST",
      "--hostname",
      "gitlab.com",
      "--include",
      "--input",
      "-",
    ]);
    expect(JSON.parse(f.writes[0]?.input ?? "null")).toEqual({
      source_branch: "topic",
      target_branch: "main",
      target_project_id: 1,
      title: "Draft: Change",
      description: "Description",
    });
  });
}
test("an unrelated source project is refused before creation", async () => {
  const f = fixture({ unrelated: true });
  await expect(
    f.backend.openPr(
      { branch: "topic", base: "main", title: "Change", body: "", draft: false },
      signal,
      { owner: "alice", name: "fork" },
    ),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(f.writes).toEqual([]);
});
test("a lost create reply is found by exact source project and branches", async () => {
  const f = fixture({ lost: true });
  await expect(
    f.backend.openPr(
      { branch: "topic", base: "main", title: "Change", body: "", draft: false },
      signal,
    ),
  ).rejects.toBeDefined();
  expect(await f.backend.findPr("topic", "main", signal)).toEqual({ repository, number: 7 });
  expect(f.writes).toHaveLength(1);
});
test("an account switch during MR creation remains uncertain", async () => {
  const f = fixture({ switched: true });
  await expect(
    f.backend.openPr(
      { branch: "topic", base: "main", title: "Change", body: "", draft: false },
      signal,
    ),
  ).rejects.toMatchObject({ kind: "outcome_uncertain" });
});
