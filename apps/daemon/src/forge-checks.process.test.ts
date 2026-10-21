import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command, WorkspaceActionRequest, type ForgeCheckAction } from "@ace/protocol";
import { fakeGh, repository, type Fixtures } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(fixtures: Fixtures) {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-checks-"));
  const gh = await fakeGh(fixtures);
  const store = new Store(join(root, "store.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const runtime = new WorkspaceRuntime(store, root, () => 1, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  cleanups.push(async () => {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return {
    gh,
    async check(checkRunId: number, jobId?: number) {
      const reply = await runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "check",
          operation: { op: "forge.pr.check", workspaceId, repository, checkRunId, jobId },
        }),
      );
      if (reply.result.kind !== "forge" || reply.result.data.resource !== "prCheck")
        throw new Error(`No check: ${JSON.stringify(reply.result)}`);
      return reply.result.data.value;
    },
    rerun(id: string, action: ForgeCheckAction) {
      return runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: {
            type: "forge.hosted.checks",
            workspaceId,
            pr: { repository, number: 7 },
            action,
          },
        }),
      );
    },
    async posts() {
      return (await gh.requests()).filter((request) => request.args.includes("POST"));
    },
  };
}

const failing = {
  id: 11,
  name: "test",
  status: "completed",
  conclusion: "failure",
  completed_at: "2026-10-02T10:00:07Z",
  details_url: "https://github.com/octo/ace/actions/runs/42/job/99",
  output: { title: "1 failing test", summary: "Tests failed", text: null },
};
const job = {
  id: 99,
  run_id: 42,
  run_attempt: 1,
  steps: [
    {
      number: 1,
      name: "Set up job",
      status: "completed",
      conclusion: "success",
      started_at: "2026-10-02T10:00:00Z",
    },
    {
      number: 2,
      name: "Run tests",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-10-02T10:00:05Z",
    },
  ],
};
const log = [
  "﻿2026-10-02T10:00:00.1000000Z ##[group]Runner image",
  "2026-10-02T10:00:00.2000000Z ubuntu-24.04",
  "2026-10-02T10:00:00.3000000Z ##[endgroup]",
  "2026-10-02T10:00:05.1000000Z ##[group]Run bun run test",
  "2026-10-02T10:00:05.2000000Z \u001b[31mFAIL\u001b[0m src/main.test.ts token=ghp_secret1",
  "2026-10-02T10:00:06.0000000Z ##[error]Process completed with exit code 1.",
  "",
].join("\n");
const annotation = {
  path: "src/main.ts",
  start_line: 12,
  end_line: 14,
  annotation_level: "failure",
  title: "main > handles empty input",
  message: "expected '' to be 'x'",
};
function actionsFixtures(): Fixtures {
  return {
    "repos/octo/ace/check-runs/11": [{ body: failing }],
    "repos/octo/ace/check-runs/11/annotations?per_page=100": [{ body: [annotation] }],
    "repos/octo/ace/actions/jobs/99": [{ body: job }],
    "repos/octo/ace/actions/jobs/99/logs": [{ raw: log }],
  };
}
const rerun = { kind: "rerun", runId: 42, attempt: 1, jobs: "failed" } as const;
const run = (attempt: number) => ({ body: { id: 42, run_attempt: attempt, status: "completed" } });

describe("a PR's checks in the panel", () => {
  it("opens a failing Actions job's log at its failing step, with its errors and annotations", async () => {
    const forge = await setup(actionsFixtures());
    const check = await forge.check(11, 99);
    const lines = check.log?.text.split("\n") ?? [];
    expect(lines).toEqual([
      "Runner image",
      "ubuntu-24.04",
      "Run bun run test",
      "FAIL src/main.test.ts token=[REDACTED]",
      "Process completed with exit code 1.",
    ]);
    expect(check.log?.focus).toBe(2);
    expect(check.log?.errors).toEqual([4]);
    expect(check.workflow).toMatchObject({ runId: 42, attempt: 1, jobId: 99 });
    expect(check.workflow?.steps.map((step) => [step.name, step.status, step.line])).toEqual([
      ["Set up job", "success", 0],
      ["Run tests", "failure", 2],
    ]);
    expect(check.annotations).toEqual([
      {
        path: "src/main.ts",
        startLine: 12,
        endLine: 14,
        level: "failure",
        title: "main > handles empty input",
        message: "expected '' to be 'x'",
      },
    ]);
  });

  it("reopening a finished check reads nothing from GitHub again", async () => {
    const forge = await setup(actionsFixtures());
    const first = await forge.check(11, 99);
    const reads = (await forge.gh.requests()).length;
    expect(await forge.check(11, 99)).toEqual(first);
    expect((await forge.gh.requests()).length).toBe(reads);
  });

  it("shows an external app's check by its summary, with no log or workflow", async () => {
    const forge = await setup({
      "repos/octo/ace/check-runs/11": [
        {
          body: {
            ...failing,
            details_url: "https://ci.example.com/build/5",
            output: { title: "Lint", summary: "3 problems", text: "src/a.ts: unused" },
          },
        },
      ],
      "repos/octo/ace/check-runs/11/annotations?per_page=100": [{ body: [] }],
    });
    const check = await forge.check(11);
    expect(check.output).toEqual({
      title: "Lint",
      summary: "3 problems",
      text: "src/a.ts: unused",
    });
    expect(check).toMatchObject({ workflow: null, log: null, logUnavailable: false });
  });

  it("says an expired Actions log is unavailable rather than showing it empty", async () => {
    const fixtures = actionsFixtures();
    fixtures["repos/octo/ace/actions/jobs/99/logs"] = [{ raw: "BlobNotFound", code: 1 }];
    const forge = await setup(fixtures);
    const check = await forge.check(11, 99);
    expect(check).toMatchObject({ log: null, logUnavailable: true });
    expect(check.workflow?.steps).toHaveLength(2);
  });
});

describe("re-running a PR's workflow run", () => {
  it("re-runs the failed jobs, or the whole run, through the run's own endpoints", async () => {
    const forge = await setup({
      "repos/octo/ace/actions/runs/42": [run(1)],
      "repos/octo/ace/actions/runs/42/rerun-failed-jobs": [{ status: 201, raw: "" }],
      "repos/octo/ace/actions/runs/42/rerun": [{ status: 201, raw: "" }],
    });
    expect(await forge.rerun("failed", rerun)).toMatchObject({ ok: true });
    expect(await forge.rerun("all", { ...rerun, jobs: "all" })).toMatchObject({ ok: true });
    expect((await forge.posts()).map((request) => request.path)).toEqual([
      "repos/octo/ace/actions/runs/42/rerun-failed-jobs",
      "repos/octo/ace/actions/runs/42/rerun",
    ]);
  });

  it("confirms a re-run whose answer was lost by the run's next attempt, and a retry writes nothing", async () => {
    const forge = await setup({
      "repos/octo/ace/actions/runs/42": [run(1), run(2)],
      "repos/octo/ace/actions/runs/42/rerun-failed-jobs": [{ offline: true }],
    });
    expect(await forge.rerun("lost", rerun)).toMatchObject({ ok: true });
    expect(await forge.rerun("retry", rerun)).toMatchObject({ ok: true });
    expect(await forge.posts()).toHaveLength(1);
  });

  it("reports a re-run it can't confirm as uncertain, not failed", async () => {
    const forge = await setup({
      "repos/octo/ace/actions/runs/42": [run(1)],
      "repos/octo/ace/actions/runs/42/rerun-failed-jobs": [{ offline: true }],
    });
    expect(await forge.rerun("lost", rerun)).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
    });
  });

  it("reports GitHub refusing a re-run as refused", async () => {
    const forge = await setup({
      "repos/octo/ace/actions/runs/42": [run(1)],
      "repos/octo/ace/actions/runs/42/rerun-failed-jobs": [
        { status: 403, body: { message: "Must have admin rights to Repository." } },
      ],
    });
    expect(await forge.rerun("refused", rerun)).toMatchObject({
      ok: false,
      error: "forge_forbidden",
    });
  });
});
