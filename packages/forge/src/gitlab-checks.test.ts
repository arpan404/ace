import { describe, expect, it } from "vitest";
import { GitLabApi } from "./gitlab-api.ts";
import { GitLabChecks, gitLabChecksWrites } from "./gitlab-checks.ts";
import { GitLabReader } from "./gitlab-reader.ts";
import { ReadBudget } from "./read-budget.ts";
import { MutationDispatch } from "./mutation.ts";
import { isAdmittedWriteRequest } from "./read-only-api.ts";
import type { CommandRequest, CommandRunner } from "./command.ts";

const repository = {
  forge: "gitlab" as const,
  host: "gitlab.com",
  owner: "team/sub",
  name: "repo",
};
const signal = () => new AbortController().signal;
const sha = "a".repeat(40);
const pipeline = (status = "running") => ({ id: 9, status, sha, future_field: true });
const job = (id = 12, status = "running") => ({
  id,
  name: "test",
  status,
  pipeline: pipeline(),
  future_field: true,
});
function fixture(
  read: (path: string, write: boolean) => unknown,
  options: { identityChanged?: true; loseWrite?: true } = {},
) {
  const seen: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    seen.push(request);
    const path = request.args[1] ?? "";
    const write = request.args[3] !== "GET";
    if (write) {
      expect(isAdmittedWriteRequest("glab", request, repository.host, gitLabChecksWrites)).toBe(
        true,
      );
      request.dispatch?.record();
      if (options.loseWrite) throw new Error("lost response");
    }
    // The MR status also reads its conversation; these checks tests don't vary it.
    const body = write
      ? read(path, write)
      : path.includes("/discussions?")
        ? []
        : path.endsWith("/approvals")
          ? { approved: false, approved_by: [] }
          : path.endsWith("/approval_state")
            ? { rules: [] }
            : read(path, write);
    return {
      code: body === undefined ? 1 : 0,
      stdout: `HTTP/2.0 ${body === undefined ? "404 Not Found" : "200 OK"}\r\nX-Next-Page: \r\n\r\n${typeof body === "string" ? body : JSON.stringify(body ?? {})}`,
      truncated: false,
      ...(write && options.identityChanged ? { identityChanged: true as const } : {}),
    };
  };
  const api = new GitLabApi({ repository, runner });
  return { api, runner, checks: new GitLabChecks(api), seen };
}
const normal = (path: string) =>
  path.includes("/jobs?")
    ? [job()]
    : path.endsWith("/trace")
      ? "\u001b[31mfailed\u001b[0m\n"
      : path.includes("/pipelines/")
        ? pipeline()
        : job();

describe("GitLab pipeline checks", () => {
  it.each(["running", "manual", "blocked", "waiting_for_resource", "future_state"])(
    "never reports %s pipelines as passed",
    async (status) => {
      const f = fixture((path) =>
        path.includes("/pipelines?")
          ? [pipeline(status)]
          : path.includes("merge_requests")
            ? { iid: 7, title: "MR", state: "opened", updated_at: "today", sha }
            : [job(12, status)],
      );
      const value = await new GitLabReader({ repository, runner: f.runner }).status(7, signal());
      expect(value.ci).toBe(status === "future_state" ? "unknown" : "pending");
      expect(value.checks[0]?.status).toBe(status === "future_state" ? "unknown" : "pending");
    },
  );
  it.each(["running", "manual", "blocked", "skipped"])(
    "does not let stale pipeline success hide a %s job",
    async (status) => {
      const f = fixture((path) =>
        path.includes("/pipelines?")
          ? [pipeline("success")]
          : path.includes("merge_requests")
            ? { iid: 7, title: "MR", state: "opened", updated_at: "today", sha }
            : [job(12, status)],
      );
      const value = await new GitLabReader({ repository, runner: f.runner }).status(7, signal());
      // A skipped job is neutral: it neither passes nor fails the pipeline.
      expect(value.ci).toBe(status === "skipped" ? "none" : "pending");
      expect(value.checks[0]?.conclusion).toBe(status);
    },
  );
  it.each<[string, { status: string; allow_failure?: boolean }[], string]>([
    [
      "a skipped job beside a passed one passes",
      [{ status: "success" }, { status: "skipped" }],
      "success",
    ],
    [
      "an optional manual job never blocks and never counts as passed",
      [{ status: "success" }, { status: "manual", allow_failure: true }],
      "success",
    ],
    [
      "only an optional manual job is no verdict",
      [{ status: "manual", allow_failure: true }],
      "none",
    ],
    [
      "a manual job that must run keeps it pending",
      [{ status: "manual", allow_failure: false }],
      "pending",
    ],
    [
      "a failure GitLab allows is a warning, not a failure",
      [{ status: "success" }, { status: "failed", allow_failure: true }],
      "success",
    ],
    [
      "a failure GitLab doesn't allow fails it",
      [{ status: "success" }, { status: "failed" }],
      "failure",
    ],
    ...["running", "created", "pending", "waiting_for_resource", "preparing", "scheduled"].map(
      (status): [string, { status: string }[], string] => [
        `a ${status} job is never passed`,
        [{ status: "success" }, { status }],
        "pending",
      ],
    ),
  ])("GitLab job rules: %s", async (_, jobs, ci) => {
    const f = fixture((path) =>
      path.includes("/pipelines?")
        ? [pipeline("success")]
        : path.includes("merge_requests")
          ? { iid: 7, title: "MR", state: "opened", updated_at: "today", sha }
          : jobs.map((each, index) => ({ ...job(12 + index, each.status), ...each })),
    );
    const value = await new GitLabReader({ repository, runner: f.runner }).status(7, signal());
    expect(value.ci).toBe(ci);
    const allowed = value.checks.find((check) => check.conclusion === "warning");
    if (allowed) expect(allowed.status).not.toBe("failure");
  });
  it("reads the newest matching MR pipeline and ignores another head", async () => {
    const f = fixture((path) =>
      path.includes("/pipelines?")
        ? [
            { ...pipeline("success"), id: 20, sha: "b".repeat(40) },
            pipeline("running"),
            { ...pipeline("success"), id: 8 },
          ]
        : path.includes("merge_requests")
          ? { iid: 7, title: "MR", state: "opened", updated_at: "today", sha }
          : [job()],
    );
    const value = await new GitLabReader({ repository, runner: f.runner }).status(7, signal());
    expect(value.ci).toBe("pending");
    expect(f.seen.some((request) => request.args[1]?.includes("/pipelines/9/jobs?"))).toBe(true);
    expect(f.seen.some((request) => request.args[1]?.includes("/pipelines/20/jobs?"))).toBe(false);
  });
  it("rejects a status snapshot whose head moved during its pipeline read", async () => {
    let reads = 0;
    const f = fixture((path) =>
      path.includes("/pipelines?")
        ? [pipeline("success")]
        : path.includes("merge_requests")
          ? {
              iid: 7,
              title: "MR",
              state: "opened",
              updated_at: "today",
              sha: ++reads === 1 ? sha : "b".repeat(40),
            }
          : [job(12, "success")],
    );
    await expect(
      new GitLabReader({ repository, runner: f.runner }).status(7, signal()),
    ).rejects.toMatchObject({ kind: "head_moved" });
  });
  it("shows job detail, canonical URL and log without terminal escapes", async () => {
    const f = fixture(normal);
    const result = await f.checks.run(12, 12, signal());
    expect(result).toMatchObject({
      id: 12,
      status: "pending",
      workflow: { runId: 9, attempt: 12, jobId: 12 },
      log: { text: "failed", truncated: false },
      url: "https://gitlab.com/team/sub/repo/-/jobs/12",
    });
    expect(f.seen.every((request) => request.args.includes("--include"))).toBe(true);
  });
  it("reports absent traces without inventing an empty successful log", async () => {
    const f = fixture((path) => (path.endsWith("/trace") ? undefined : normal(path)));
    expect(await f.checks.run(12, undefined, signal())).toMatchObject({
      log: null,
      logUnavailable: true,
    });
  });
  it("keeps newest log bytes and refuses reads exceeding the cumulative budget", async () => {
    const f = fixture((path) =>
      path.endsWith("/trace") ? "old\n" + "x".repeat(1_048_576) + "\nlast" : normal(path),
    );
    const result = await f.checks.run(12, undefined, signal());
    expect(result.log?.truncated).toBe(true);
    expect(result.log?.text.endsWith("last")).toBe(true);
    const budget = new ReadBudget();
    budget.add(8_388_600);
    await expect(f.api.get(`${f.api.root}/jobs/12`, signal(), budget)).rejects.toMatchObject({
      kind: "limit",
    });
  });
  it("retries failed pipeline jobs with the exact admitted JSON stdin shape", async () => {
    const f = fixture((path) =>
      path.includes("/jobs?") ? [job(12, "failed")] : pipeline("pending"),
    );
    await f.checks.rerun({ runId: 9, attempt: 12, jobs: "failed" }, signal(), () => true);
    expect(f.seen.at(-1)).toMatchObject({
      args: [
        "api",
        "projects/team%2Fsub%2Frepo/pipelines/9/retry",
        "-X",
        "POST",
        "--hostname",
        "gitlab.com",
        "--include",
        "--input",
        "-",
      ],
      input: "{}",
    });
  });
  it("retries all finished jobs individually, including successful jobs", async () => {
    const f = fixture((path) =>
      path.includes("/jobs?") ? [job(11, "success"), job(12, "failed")] : job(13, "pending"),
    );
    await f.checks.rerun({ runId: 9, attempt: 12, jobs: "all" }, signal(), () => true);
    expect(
      f.seen.filter((request) => request.input !== undefined).map((request) => request.args[1]),
    ).toEqual([`${f.api.root}/jobs/11/retry`, `${f.api.root}/jobs/12/retry`]);
  });
  it("does not retry a newer attempt and refuses stale cancel", async () => {
    const f = fixture(normal);
    await f.checks.rerun({ runId: 9, attempt: 11, jobs: "failed" }, signal(), () => true);
    await expect(
      f.checks.cancel({ runId: 9, attempt: 11 }, signal(), () => true),
    ).rejects.toMatchObject({ kind: "run_attempt_moved" });
    expect(f.seen.every((request) => request.input === undefined)).toBe(true);
  });
  it("does not cancel completed pipelines and checks permission immediately before dispatch", async () => {
    const f = fixture((path) => (path.includes("/jobs?") ? [job()] : pipeline("success")));
    await f.checks.cancel({ runId: 9, attempt: 12 }, signal(), () => true);
    const active = fixture(normal);
    await expect(
      active.checks.cancel({ runId: 9, attempt: 12 }, signal(), () => false),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect([...f.seen, ...active.seen].every((request) => request.input === undefined)).toBe(true);
  });
  it("keeps manual pipelines cancellable and reports identity changes as uncertain", async () => {
    const f = fixture((path) => (path.includes("/jobs?") ? [job()] : pipeline("manual")), {
      identityChanged: true,
    });
    await expect(
      f.checks.cancel({ runId: 9, attempt: 12 }, signal(), () => true),
    ).rejects.toMatchObject({ kind: "outcome_uncertain" });
  });
  it("retains dispatch evidence when a retry response is lost", async () => {
    const f = fixture((path) => (path.includes("/jobs?") ? [job(12, "failed")] : pipeline()), {
      loseWrite: true,
    });
    const dispatch = new MutationDispatch();
    await expect(
      f.checks.rerun({ runId: 9, attempt: 12, jobs: "failed" }, signal(), () => true, dispatch),
    ).rejects.toMatchObject({ kind: "outcome_uncertain" });
    expect(dispatch.definitelyFailed).toBe(false);
  });
  it("does not settle a partially completed retry of all jobs", async () => {
    const f = fixture(() => [job(11, "success"), job(13, "pending")]);
    expect(await f.checks.rerunLanded(9, 12, signal(), "all")).toBe(false);
    await expect(
      f.checks.rerun({ runId: 9, attempt: 12, jobs: "all" }, signal(), () => true),
    ).rejects.toMatchObject({ kind: "outcome_uncertain" });
  });
});
