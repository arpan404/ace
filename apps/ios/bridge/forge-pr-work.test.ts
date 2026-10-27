import "./test-host.ts";
import { seedPrWork } from "@ace/fake-daemon";
import { expect, test } from "vitest";
import type { CheckReply, ChecksReply } from "./forge-checks.ts";
import type { ConflictsReply } from "./forge-conflicts.ts";
import type { LogPage } from "./forge-log-pages.ts";
import type { ManageReply, ManageWriteReply } from "./forge-manage.ts";
import type { PullReply } from "./forge-pull.ts";
import type { StackReply } from "./forge-stack.ts";
import type { WorkReply } from "./forge-worktree.ts";
import { connected, repository as ace } from "./forge-test-fixture.ts";

/*
 * The work a pull request page starts from the phone, on the fake daemon's GitHub
 * (`seedPrWork`): #229's check runs, #226's linked thread with its conflicts and stack, and
 * merged #212's revert.
 */

type Ask = (request: Record<string, unknown>) => Promise<unknown>;
async function work() {
  const fixture = await connected();
  seedPrWork(fixture.daemon, Date.parse("2026-10-20T00:00:00Z"));
  return fixture;
}
const checks = async (ask: Ask, number: number) =>
  (await ask({ type: "forge.pull.checks", project: "ace", number, fresh: true })) as ChecksReply;
const check = async (ask: Ask, number: number, checkId: string) =>
  (await ask({
    type: "forge.pull.check",
    project: "ace",
    number,
    checkId,
    fresh: true,
  })) as CheckReply;
const word = (reply: ChecksReply, name: string) =>
  reply.checks.find((each) => each.name === name)?.word;

test("a failing check opens on its annotations and a log read page by page, with a fix to hand over", async () => {
  const { ask } = await work();
  const listed = await checks(ask, 229);
  const failing = listed.checks.find((each) => each.name === "test (web)");
  expect(failing).toMatchObject({ word: "Failed", tone: "failed", opens: true });
  const page = await check(ask, 229, failing?.id ?? "");
  expect(page.annotations).toMatchObject([
    { where: "apps/web/src/features/thread/composer/toolbar.test.tsx:42", level: "Error" },
  ]);
  expect(page.controls).toEqual({ rerunFailed: true, rerunAll: true, cancel: false, fix: true });
  expect(page.fix?.request).toContain("Error: expected the model chip to stay in the toolbar");
  // A fix can always start a thread of its own on the PR, at the head the page showed.
  expect(page.fix?.pullRequest).toMatchObject({ number: 229, headSha: listed.headSha });
  expect(page.log?.lines).toBeGreaterThan(1_400);
  // The log is drawn from its failing step, a page at a time.
  const lines = (await ask({
    type: "forge.pull.check.log",
    project: "ace",
    checkRunId: page.checkRunId,
    jobId: page.jobId,
    finished: true,
    from: page.log?.focus ?? 0,
    count: 3,
  })) as LogPage;
  expect(lines.lines).toEqual([
    "Run bun run test",
    "FAIL apps/web/src/features/thread/composer/toolbar.test.tsx",
    "Error: expected the model chip to stay in the toolbar",
  ]);
});

test("re-running failed jobs and cancelling a running one show in the checks read afterwards", async () => {
  const { ask, sent } = await work();
  const before = await checks(ask, 229);
  const failing = await check(
    ask,
    229,
    before.checks.find((each) => each.name === "test (web)")?.id ?? "",
  );
  const rerun = await ask({
    type: "forge.checks.write",
    project: "ace",
    number: 229,
    repository: ace,
    action: { kind: "rerun", jobs: "failed", ...failing.workflow },
  });
  expect(rerun).toMatchObject({ ok: true });
  expect(word(await checks(ask, 229), "test (web)")).toBe("Running");
  const running = await check(
    ask,
    229,
    before.checks.find((each) => each.name === "e2e (ios)")?.id ?? "",
  );
  expect(running.controls.cancel).toBe(true);
  await ask({
    type: "forge.checks.write",
    project: "ace",
    number: 229,
    repository: ace,
    action: { kind: "cancel", runId: running.workflow?.runId },
  });
  expect(word(await checks(ask, 229), "e2e (ios)")).toBe("Cancelled");
  expect(sent.filter((each) => each.type === "forge.hosted.checks")).toHaveLength(2);
});

test("the local check of the head shown starts from the phone and can be stopped", async () => {
  const { ask, daemon } = await work();
  daemon.services.verify.stepMs = 60_000;
  const before = await checks(ask, 229);
  expect(before.local).toMatchObject({
    word: "Not run",
    action: { kind: "start", label: "Run checks" },
  });
  const started = await ask({
    type: "forge.local.write",
    project: "ace",
    number: 229,
    repository: ace,
    action: { kind: "start", headSha: before.headSha },
  });
  expect(started).toMatchObject({ ok: true });
  const live = await checks(ask, 229);
  expect(live.local?.action).toMatchObject({ kind: "cancel", label: "Stop" });
  await ask({
    type: "forge.local.write",
    project: "ace",
    number: 229,
    repository: ace,
    action: { kind: "cancel", runId: live.local?.runId },
  });
  expect((await checks(ask, 229)).local).toMatchObject({
    word: "Stopped",
    action: { label: "Run again" },
  });
});

test("conflicts resolve hunk by hunk in the linked thread's checkout, then commit and push", async () => {
  const { ask, daemon, sent } = await work();
  const conflicts = async () =>
    (await ask({
      type: "forge.pull.conflicts",
      project: "ace",
      number: 226,
      fresh: true,
    })) as ConflictsReply;
  const step = (value: Record<string, unknown>) =>
    ask({
      type: "forge.conflicts",
      project: "ace",
      number: 226,
      repository: ace,
      threadId: "pr-work-226",
      step: value,
    });
  const before = await conflicts();
  expect(before).toMatchObject({
    threadId: "pr-work-226",
    checkout: { merging: false, files: [] },
  });
  expect(await step({ action: "start", head: before.checkout?.head })).toMatchObject({ ok: true });
  const merging = await conflicts();
  expect(
    merging.checkout?.files.map((file) => [file.path, file.hunks.length, file.unavailable]),
  ).toEqual([
    ["apps/web/src/features/thread/composer/toolbar.tsx", 1, null],
    ["apps/web/src/features/thread/composer/composer.tsx", 1, null],
    ["apps/web/public/toolbar.png", 0, "Binary file: take one side."],
  ]);
  const [toolbar, composer] = merging.checkout?.files ?? [];
  await step({
    action: "resolve",
    path: toolbar?.path,
    revision: toolbar?.revision,
    hunk: 0,
    choice: { kind: "both" },
  });
  expect(daemon.workspace.conflicts.written[0]?.content).toBe(
    'import { ModelChip } from "./model-chip.tsx";\n\nexport function Toolbar() {\n  return <ModelChip compact />;\nexport function Toolbar(props: { compact: boolean }) {\n  return <ModelChip compact={props.compact} />;\n}\n',
  );
  await step({
    action: "resolve",
    path: composer?.path,
    revision: composer?.revision,
    hunk: 0,
    choice: { kind: "theirs" },
  });
  await step({ action: "take", path: "apps/web/public/toolbar.png", side: "ours" });
  expect((await conflicts()).checkout?.files).toEqual([]);
  expect(await step({ action: "finish", head: before.checkout?.head })).toMatchObject({
    ok: true,
    message: "Pushed the merge to refactor/composer-toolbar",
  });
  expect(sent.map((each) => each.type).slice(-2)).toEqual(["git.conflicts", "git.push"]);
});

test("a stack rebases locally from the phone, then offers to publish what it rebased", async () => {
  const { ask, daemon } = await work();
  const stack = async () =>
    (await ask({
      type: "forge.pull.stack",
      project: "ace",
      number: 226,
      fresh: true,
    })) as StackReply;
  const before = await stack();
  expect(before.stack?.layers.map((layer) => [layer.number, layer.current])).toEqual([
    [224, false],
    [226, true],
  ]);
  const merge = before.controls.find((control) => control.action === "merge");
  expect(merge).toMatchObject({ label: "Merge through #226", reason: null });
  expect(merge?.confirm?.text).toBe(
    "Merge #224, #226 into main using squash. A merge queue chooses its own method.",
  );
  const rebase = before.controls.find((control) => control.action === "rebase");
  const written = await ask({
    type: "forge.stack",
    project: "ace",
    number: 226,
    repository: ace,
    threadId: "pr-work-226",
    action: "rebase",
    method: "squash",
    review: rebase?.confirm?.review,
  });
  expect(written).toMatchObject({ ok: true });
  const after = await stack();
  expect(after.operation?.label).toBe("Rebased, not pushed");
  const publish = after.controls.find((control) => control.action === "push");
  expect(publish).toMatchObject({ label: "Publish stack", reason: null });
  expect(publish?.confirm?.lines).toHaveLength(2);
  expect(daemon.workspace.prWork.stackChanges.map((change) => change.action)).toEqual(["rebase"]);
});

test("checking a pull request out in its linked thread shows that thread holding its head", async () => {
  const { ask } = await work();
  const read = async () =>
    (await ask({ type: "forge.pull.work", project: "ace", number: 226, fresh: true })) as WorkReply;
  const before = await read();
  expect(before).toMatchObject({ blocked: null, threads: [{ id: "pr-work-226", checkout: null }] });
  expect(
    await ask({
      type: "forge.worktree",
      project: "ace",
      number: 226,
      repository: ace,
      threadId: "pr-work-226",
      headSha: before.headSha,
    }),
  ).toMatchObject({ ok: true });
  const after = await read();
  expect(after.threads[0]).toMatchObject({
    checkout: "current",
    branch: "refactor/composer-toolbar",
  });
});

test("a merged pull request's revert opens a draft pull request that reads back", async () => {
  const { ask } = await work();
  const manage = (await ask({
    type: "forge.pull.manage",
    project: "ace",
    number: 212,
  })) as ManageReply;
  expect(manage.revert).toEqual({
    title: 'Revert "Bump Codex app-server to 0.48"',
    body: "Reverts #212.\n\nThis draft proposes undoing the merged change. Review the generated diff and required checks before merging.",
  });
  const reverted = (await ask({
    type: "forge.manage",
    project: "ace",
    number: 212,
    repository: ace,
    operation: {
      kind: "apply",
      version: manage.version,
      action: { kind: "revert", ...manage.revert },
    },
  })) as ManageWriteReply;
  expect(reverted).toMatchObject({ ok: true, message: `Opened draft #${reverted.opened}` });
  const draft = (await ask({
    type: "forge.pull",
    project: "ace",
    number: reverted.opened,
  })) as PullReply;
  expect(draft).toMatchObject({
    title: 'Revert "Bump Codex app-server to 0.48"',
    state: { word: "Draft" },
  });
});
