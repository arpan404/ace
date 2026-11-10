import { expect, test } from "vitest";
import { TeaWriter } from "./tea-writes.ts";
import { TeaReviews } from "./tea-reviews.ts";
import { TeaIssueWriter } from "./tea-issue-writes.ts";
import { MutationDispatch } from "./mutation.ts";
import type { CommandResult, CommandRunner } from "./command.ts";

const head = "a".repeat(40);
const signal = new AbortController().signal;
const repository = { forge: "gitea" as const, host: "git.example", owner: "team", name: "app" };

/** What the host does with the write once it reaches it. */
type Reply = { status: number; identityChanged?: true } | { lost: true } | { unreachable: true };

/** Reads per Gitea's API v1 (gitea.com/swagger.v1.json); the one write gets `reply`. */
function host(reply: Reply): CommandRunner {
  const ok = (body: unknown): CommandResult => ({
    code: 0,
    stdout: JSON.stringify(body),
    truncated: false,
    http: { status: 200, headers: {} },
  });
  return async (request) => {
    const path = request.args[1] ?? "";
    if (request.input !== undefined) {
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      if ("lost" in reply) throw new Error("response lost after sending");
      if ("unreachable" in reply)
        return { code: 1, stdout: "", truncated: false, unreachable: true };
      return {
        code: reply.status < 300 ? 0 : 1,
        stdout: reply.status < 300 ? '{"id":12,"number":3}' : '{"message":"no"}',
        truncated: false,
        http: { status: reply.status, headers: {} },
        ...(reply.identityChanged ? { identityChanged: true as const } : {}),
      };
    }
    if (path === "user") return ok({ login: "work" });
    if (path === "repos/team/app")
      return ok({
        archived: false,
        has_issues: true,
        permissions: { push: true },
        allow_merge_commits: true,
        allow_squash_merge: true,
        allow_rebase: true,
      });
    if (path.includes("/status?"))
      return ok({ sha: head, state: "success", total_count: 0, statuses: [] });
    if (/\/(comments|reviews)\?/.test(path)) return ok([]);
    if (path === "repos/team/app/issues/3")
      return ok({
        number: 3,
        title: "Bug",
        state: "open",
        user: { login: "alice" },
        created_at: "2026-01-01",
        updated_at: "2026-01-02",
        labels: [],
        assignees: [],
      });
    return ok({
      number: 7,
      title: "Feature",
      state: "open",
      merged: false,
      mergeable: true,
      head: { sha: head, ref: "feature" },
      base: { sha: "b".repeat(40), ref: "main" },
      user: { login: "alice" },
    });
  };
}

const writes: Record<
  string,
  (runner: CommandRunner, dispatch: MutationDispatch) => Promise<unknown>
> = {
  merge: (runner, dispatch) =>
    new TeaWriter({ repository, login: "work", runner }).merge(7, head, "merge", signal, dispatch),
  "review comment": (runner, dispatch) =>
    new TeaReviews({ repository, login: "work", runner }).write(
      7,
      { kind: "conversation", body: "Hello" },
      [],
      "operation",
      signal,
      () => true,
      dispatch,
    ),
  "issue comment": (runner, dispatch) =>
    new TeaIssueWriter({ repository, login: "work", runner }).writeIssue(
      { action: "comment", number: 3, body: "Reply" },
      "operation",
      signal,
      dispatch,
    ),
};

for (const [name, write] of Object.entries(writes)) {
  test.each([400, 401, 403, 404, 405, 409, 412, 422, 429])(
    `a Gitea ${name} the host refuses with %i under the same account has definitely failed`,
    async (status) => {
      const dispatch = new MutationDispatch();
      await expect(write(host({ status }), dispatch)).rejects.toMatchObject({ dispatched: false });
      expect(dispatch.definitelyFailed).toBe(true);
    },
  );

  test.each<[string, Reply]>([
    ["a server error", { status: 500 }],
    ["a bad gateway", { status: 502 }],
    ["a lost response", { lost: true }],
    ["a dropped connection", { unreachable: true }],
    ["a refusal after the account changed", { status: 403, identityChanged: true }],
    ["a success after the account changed", { status: 201, identityChanged: true }],
  ])(`a Gitea ${name} sent and then met with %s is uncertain`, async (_, reply) => {
    const dispatch = new MutationDispatch();
    await expect(write(host(reply), dispatch)).rejects.toMatchObject({
      kind: "outcome_uncertain",
    });
    expect(dispatch.definitelyFailed).toBe(false);
  });
}
