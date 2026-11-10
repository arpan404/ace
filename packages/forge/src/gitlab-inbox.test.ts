import { expect, test } from "vitest";
import { GitLabApi } from "./gitlab-api.ts";
import { GitLabInbox, gitLabInboxWrites } from "./gitlab-inbox.ts";
import { MutationDispatch } from "./mutation.ts";
import { isAdmittedWriteRequest } from "./read-only-api.ts";
import type { CommandRequest, CommandRunner } from "./command.ts";
const repository = { forge: "gitlab" as const, host: "gitlab.com", owner: "team", name: "repo" };
const signal = new AbortController().signal;
const todo = {
  id: 8,
  project: { id: 1, path_with_namespace: "team/sub/repo" },
  action_name: "mentioned",
  target_type: "MergeRequest",
  target: { iid: 7, title: "Change", state: "opened", future: true },
  body: "Mention",
  state: "pending",
  created_at: "2026-11-01T00:00:00Z",
  target_url: "https://evil.example/steal",
  future_field: { kept: true },
};
function fixture(options: { changed?: true; wrongAck?: boolean } = {}) {
  const writes: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    let body: unknown = [todo];
    if (request.input !== undefined) {
      expect(isAdmittedWriteRequest("glab", request, repository.host, gitLabInboxWrites)).toBe(
        true,
      );
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push(request);
      body = { ...todo, state: options.wrongAck ? "pending" : "done" };
    }
    return {
      code: 0,
      truncated: false,
      stdout: `HTTP/2 200 OK\nx-next-page: \n\n${JSON.stringify(body)}`,
      ...(options.changed && request.input !== undefined ? { identityChanged: true } : {}),
    };
  };
  return { inbox: new GitLabInbox(new GitLabApi({ repository, runner })), writes };
}
test("to-dos map MR identifiers, nested project paths and canonical URLs while retaining the host reason", async () => {
  const f = fixture();
  expect(await f.inbox.list({ all: false, participating: false, page: 1 }, signal)).toMatchObject({
    host: "gitlab.com",
    unchanged: false,
    items: [
      {
        id: "8",
        repository: { ...repository, owner: "team/sub" },
        type: "PullRequest",
        number: 7,
        state: "open",
        title: "Change",
        reason: "mentioned",
        unread: true,
        url: "https://gitlab.com/team/sub/repo/-/merge_requests/7",
      },
    ],
  });
  expect(await f.inbox.find("8", signal)).toMatchObject({
    id: "8",
    repository: { ...repository, owner: "team/sub" },
  });
});
test("mark done sends exactly its admitted endpoint and empty JSON stdin", async () => {
  const f = fixture();
  await f.inbox.write({ action: "done", id: "8" }, signal, new MutationDispatch());
  expect(f.writes[0]?.args).toEqual([
    "api",
    "todos/8/mark_as_done",
    "-X",
    "POST",
    "--hostname",
    "gitlab.com",
    "--include",
    "--input",
    "-",
  ]);
  expect(f.writes[0]?.input).toBe("{}");
});
for (const options of [{ changed: true as const }, { wrongAck: true }])
  test("an unconfirmed to-do acknowledgement stays uncertain", async () => {
    const f = fixture(options);
    await expect(
      f.inbox.write({ action: "done", id: "8" }, signal, new MutationDispatch()),
    ).rejects.toMatchObject({ kind: "outcome_uncertain" });
  });
test("unsupported notification actions and missing to-dos never dispatch", async () => {
  const f = fixture();
  for (const action of ["read", "unsubscribe"] as const)
    await expect(f.inbox.write({ action, id: "8" }, signal)).rejects.toMatchObject({
      kind: "unsupported",
    });
  await expect(f.inbox.find("99", signal)).rejects.toMatchObject({ kind: "not_found" });
  expect(f.writes).toEqual([]);
});
