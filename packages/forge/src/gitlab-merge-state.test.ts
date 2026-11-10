import { expect, test } from "vitest";
import type { CommandRequest, CommandRunner } from "./command.ts";
import { GitLabApi } from "./gitlab-api.ts";
import { GitLabMergeState, gitlabMergeState, gitlabMergeWrites } from "./gitlab-merge-state.ts";
import { MutationDispatch } from "./mutation.ts";
import { isAdmittedWriteRequest } from "./read-only-api.ts";

const head = "a".repeat(40);
const moved = "b".repeat(40);
const repository = {
  forge: "gitlab" as const,
  host: "gitlab.example.com",
  owner: "team/sub",
  name: "ace",
};
const root = "projects/team%2Fsub%2Face";
const path = `${root}/merge_requests/7`;
const signal = new AbortController().signal;
const mr = {
  iid: 7,
  sha: head,
  state: "opened",
  draft: false,
  detailed_merge_status: "mergeable",
  merge_when_pipeline_succeeds: false,
  squash: false,
  user: { can_merge: true },
  head_pipeline: { id: 12, sha: head, status: "success" },
};
function environment(
  options: {
    source?: Record<string, unknown>;
    jobs?: string[];
    writeBody?: unknown;
    identityChanged?: true;
    loseWrite?: boolean;
    squashOption?: string;
    version?: string;
    writeCode?: number;
  } = {},
) {
  const writes: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    const endpoint = request.args[1];
    let body: unknown;
    if (request.input !== undefined) {
      expect(isAdmittedWriteRequest("glab", request, repository.host, gitlabMergeWrites)).toBe(
        true,
      );
      request.dispatch?.prepare?.();
      request.dispatch?.record();
      writes.push(request);
      if (options.loseWrite) throw new Error("connection lost");
      body = options.writeBody ?? { ...mr, state: "merged" };
    } else if (endpoint === "version") body = { version: options.version ?? "18.4.1-ee" };
    else if (endpoint === path) body = { ...mr, ...options.source };
    else if (endpoint === root) body = { squash_option: options.squashOption ?? "default_off" };
    else if (endpoint === `${path}/pipelines?per_page=100&page=1`)
      body = [{ id: 12, sha: head, status: "success" }];
    else if (endpoint === `${root}/pipelines/12/jobs?per_page=100&page=1&include_retried=false`) {
      body = (options.jobs ?? ["success"]).map((status, index) => ({
        id: index + 1,
        name: `job-${index}`,
        status,
        pipeline: { id: 12, sha: head, status: "success" },
      }));
    } else throw new Error(`unexpected endpoint ${endpoint}`);
    return {
      code: 0,
      stdout: `HTTP/2 ${request.input !== undefined ? (options.writeCode ?? 200) : 200} OK\r\n\r\n${JSON.stringify(body)}`,
      truncated: false,
      ...(request.input !== undefined && options.identityChanged ? { identityChanged: true } : {}),
    };
  };
  return {
    backend: new GitLabMergeState(new GitLabApi({ repository, runner }), repository),
    writes,
  };
}

test("only the reviewed head and edited squash message travel through the admitted write", async () => {
  const { backend, writes } = environment();
  await backend.merge(7, head, "squash", signal, undefined, { title: "Fix", message: "Details" });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.args).toEqual([
    "api",
    `${path}/merge`,
    "-X",
    "PUT",
    "--hostname",
    repository.host,
    "--include",
    "--input",
    "-",
  ]);
  expect(JSON.parse(writes[0]?.input ?? "")).toEqual({
    sha: head,
    squash: true,
    auto_merge: false,
    squash_commit_message: "Fix\n\nDetails",
  });
});

test("a moved head is refused without dispatch", async () => {
  const { backend, writes } = environment({ source: { sha: moved } });
  await expect(backend.merge(7, head, "merge", signal)).rejects.toMatchObject({
    kind: "head_moved",
    dispatched: false,
  });
  expect(writes).toEqual([]);
});

for (const status of ["running", "manual", "blocked", "failed", "future_status"]) {
  test(`a successful pipeline cannot override ${status} jobs`, async () => {
    const { backend, writes } = environment({ jobs: ["success", status] });
    const state = await backend.read(7, signal);
    expect(state.checksState).not.toBe("SUCCESS");
    await expect(backend.merge(7, head, "merge", signal)).rejects.toMatchObject({
      kind: "conflict",
    });
    expect(writes).toEqual([]);
  });
}
for (const source of [
  { head_pipeline: null },
  { head_pipeline: undefined },
  { detailed_merge_status: "not_approved" },
  { detailed_merge_status: "discussions_not_resolved" },
  { detailed_merge_status: "future_status" },
  { draft: true },
  { user: { can_merge: false } },
  { blocking_discussions_resolved: false },
  { head_pipeline: { id: 12, sha: moved, status: "success" } },
]) {
  test(`direct merge refuses incomplete or blocked host facts ${JSON.stringify(source)}`, async () => {
    const { backend, writes } = environment({ source });
    await expect(backend.merge(7, head, "merge", signal)).rejects.toBeDefined();
    expect(writes).toEqual([]);
  });
}

test("empty jobs cannot establish successful checks", async () => {
  const { backend, writes } = environment({ jobs: [] });
  expect((await backend.read(7, signal)).checksState).toBe("UNKNOWN");
  await expect(backend.merge(7, head, "merge", signal)).rejects.toMatchObject({ kind: "conflict" });
  expect(writes).toEqual([]);
});

test("unknown host fields survive while merge and checks use consumer states", () => {
  const raw = { ...mr, future_field: { retained: true } };
  expect(gitlabMergeState(raw)).toMatchObject({ mergeState: "CLEAN", checksState: "SUCCESS", raw });
  expect(gitlabMergeState({ ...mr, detailed_merge_status: "conflict" }).mergeState).toBe("DIRTY");
  expect(gitlabMergeState({ ...mr, detailed_merge_status: "checking" }).mergeState).toBe("UNKNOWN");
  expect(gitlabMergeState({ ...mr, detailed_merge_status: "not_approved" })).toMatchObject({
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
  });
});

test("auto-merge waits for checks using the pinned head without claiming immediate merge", async () => {
  const { backend, writes } = environment({
    jobs: ["running"],
    writeBody: { ...mr, merge_when_pipeline_succeeds: true, squash: true },
  });
  await expect(backend.change(7, head, "enable", "squash", signal)).resolves.toBeUndefined();
  expect(JSON.parse(writes[0]?.input ?? "")).toEqual({ sha: head, squash: true, auto_merge: true });
});

test("already enabled auto-merge reconciles without writing", async () => {
  const { backend, writes } = environment({ source: { merge_when_pipeline_succeeds: true } });
  expect((await backend.change(7, head, "enable", "merge", signal))?.autoMerge?.method).toBe(
    "MERGE",
  );
  expect(writes).toEqual([]);
});

test("cancellation validates the status acknowledgement rather than HTTP success alone", async () => {
  const { backend, writes } = environment({
    source: { merge_when_pipeline_succeeds: true },
    writeBody: { status: "error" },
  });
  const dispatch = new MutationDispatch();
  await expect(
    backend.change(7, head, "disable", "merge", signal, () => true, dispatch),
  ).rejects.toMatchObject({ kind: "outcome_uncertain" });
  expect(dispatch.definitelyFailed).toBe(false);
  expect(writes[0]?.args[1]).toBe(`${path}/cancel_merge_when_pipeline_succeeds`);
  expect(writes[0]?.input).toBe("{}");
});

test("an acknowledged cancellation returns before a follow-up read", async () => {
  const { backend } = environment({
    source: { merge_when_pipeline_succeeds: true },
    writeBody: { status: "success" },
  });
  await expect(backend.change(7, head, "disable", "merge", signal)).resolves.toBeUndefined();
});

for (const options of [{ writeBody: {} }, { identityChanged: true as const }]) {
  test(`a malformed or differently identified acknowledgement stays uncertain ${JSON.stringify(options)}`, async () => {
    const { backend } = environment(options);
    const dispatch = new MutationDispatch();
    await expect(backend.merge(7, head, "merge", signal, dispatch)).rejects.toMatchObject({
      kind: "outcome_uncertain",
    });
    expect(dispatch.definitelyFailed).toBe(false);
  });
}

test("a lost write response remains dispatched for the durable journal to reconcile", async () => {
  const { backend, writes } = environment({ loseWrite: true });
  const dispatch = new MutationDispatch();
  await expect(backend.merge(7, head, "merge", signal, dispatch)).rejects.toBeDefined();
  expect(dispatch.definitelyFailed).toBe(false);
  expect(writes).toHaveLength(1);
});

test("the repository squash policy cannot silently change the selected method", async () => {
  const { backend, writes } = environment({ squashOption: "always" });
  expect((await backend.read(7, signal)).methods).toEqual(["squash"]);
  await expect(backend.merge(7, head, "merge", signal)).rejects.toMatchObject({ kind: "conflict" });
  expect(writes).toEqual([]);
});

test("revoked admission and unsupported rebase or dequeue never dispatch", async () => {
  const { backend, writes } = environment();
  await expect(
    backend.change(7, head, "enable", "merge", signal, () => false),
  ).rejects.toMatchObject({ kind: "forbidden" });
  await expect(backend.merge(7, head, "rebase", signal)).rejects.toMatchObject({
    kind: "unsupported",
  });
  await expect(backend.change(7, head, "dequeue", "merge", signal)).rejects.toMatchObject({
    kind: "unsupported",
  });
  expect(writes).toEqual([]);
});

test("older GitLab servers receive the documented pipeline auto-merge parameter", async () => {
  const { backend, writes } = environment({
    version: "16.11.0",
    jobs: ["running"],
    writeBody: { ...mr, merge_when_pipeline_succeeds: true },
  });
  await backend.change(7, head, "enable", "merge", signal);
  expect(JSON.parse(writes[0]?.input ?? "null")).toEqual({
    sha: head,
    squash: false,
    merge_when_pipeline_succeeds: true,
  });
});
test("an unreadable server version never guesses an auto-merge strategy", async () => {
  const { backend, writes } = environment({ version: "future" });
  await expect(backend.change(7, head, "enable", "merge", signal)).rejects.toMatchObject({
    kind: "unsupported",
  });
  expect(writes).toEqual([]);
});

test("a host SHA rejection after preflight is a definite head-moved refusal", async () => {
  const { backend } = environment({ writeCode: 409, writeBody: { message: "SHA does not match" } });
  const dispatch = new MutationDispatch();
  await expect(backend.merge(7, head, "merge", signal, dispatch)).rejects.toMatchObject({
    kind: "head_moved",
    dispatched: false,
  });
  expect(dispatch.definitelyFailed).toBe(true);
});
