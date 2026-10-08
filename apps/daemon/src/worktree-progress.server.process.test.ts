import { writeFile, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  Command,
  ThreadId,
  type ServerMessage,
  type WorktreeCreationProgress,
} from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { startServer } from "./server.ts";
import { token } from "./socket-test-support.ts";
import { connect, git, repository, command } from "./thread-creation-test-support.ts";
import { until } from "./projects-test-support.ts";

async function fixture() {
  const h = transitionHarness();
  await repository(h.home);
  await Promise.all(
    Array.from({ length: 2048 }, (_, index) =>
      writeFile(join(h.home, `fixture-${index}.txt`), `Synthetic ${index}\n`),
    ),
  );
  await git("git", [
    "-C",
    h.home,
    "add",
    "--",
    ...Array.from({ length: 2048 }, (_, index) => `fixture-${index}.txt`),
  ]);
  await git("git", [
    "-C",
    h.home,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Many files",
  ]);
  await h.engine.ready();
  let now = 1000;
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => ++now);
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    workspaceActions: runtime,
    port: 0,
    hostId: "host",
    token,
  });
  const client = await connect(server.url);
  const draft = Command.parse({
    id: "create-progress",
    deviceId: "device",
    payload: {
      type: "thread.create",
      threadId: "progress",
      workspaceId: h.workspace,
      provider: "codex",
      mode: "worktree",
      base: { ref: "main" },
      input: [{ type: "text", text: "Keep this exact first message" }],
    },
  });
  const send = () => client.send({ type: "command", command: draft });
  const action = (choice: "cancel" | "local" | "retry" | "get") =>
    client.send({
      type: "worktree.creation.request",
      requestId: choice,
      commandId: draft.id,
      action: choice,
    });
  const receipt = () =>
    until(client, (message) => message.type === "commandResult" && message.commandId === draft.id);
  const nextProgress = () =>
    until(client, (message) => message.type === "worktree.creation.progress");
  const close = async () => {
    await client.close();
    await server.close();
    await runtime.close();
    await h.close();
  };
  return { h, runtime, server, client, draft, send, action, receipt, nextProgress, close };
}
function progress(message: ServerMessage): WorktreeCreationProgress {
  if (message.type !== "worktree.creation.progress") throw new Error("Expected creation progress");
  return message;
}

test("creation streams ordered steps, real checkout percentages and timings before delivering the first message", async () => {
  const f = await fixture();
  try {
    const remote = join(f.h.home, "remote.git");
    await git("git", ["clone", "--bare", f.h.home, remote]);
    await git("git", ["-C", f.h.home, "remote", "add", "origin", remote]);
    const p = f.draft.payload;
    if (p.type !== "thread.create") throw new Error("Missing creation draft");
    f.client.send({
      type: "command",
      command: Command.parse({
        ...f.draft,
        payload: { ...p, base: { ref: "main", remote: "origin" } },
      }),
    });
    const reports: WorktreeCreationProgress[] = [];
    for (;;) {
      const report = progress(await f.nextProgress());
      reports.push(report);
      if (report.state === "done") break;
    }
    expect(await f.receipt()).toMatchObject({ ok: true, threadId: "progress" });
    expect([...new Set(reports.map((report) => report.step))]).toEqual([
      "preparing",
      "fetching",
      "creating",
      "checking_out",
      "done",
    ]);
    const percentages = reports
      .filter((report) => report.step === "checking_out")
      .flatMap((report) => (report.percent === undefined ? [] : [report.percent]));
    expect(percentages[0]).toBe(0);
    expect(percentages.at(-1)).toBe(100);
    expect(new Set(percentages).size).toBeGreaterThan(2);
    expect(percentages.every((value, index) => value >= (percentages[index - 1] ?? 0))).toBe(true);
    expect(reports.at(-1)?.elapsedMs).toBeGreaterThan(0);
    await f.h.engine.flush();
    expect(f.h.inputs.map((input) => input.text)).toEqual(["Keep this exact first message"]);
    const details = f.h.store.getThread(ThreadId.parse("progress"))?.details;
    expect(details?.worktreeCreation).toMatchObject({ state: "done", cleanupComplete: true });
    const path = details?.worktree;
    if (!path) throw new Error("Missing admitted workspace");
    await access(join(path, "fixture-2047.txt"));
  } finally {
    await f.close();
  }
});

test("cancel during checkout cleans the branch and worktree and retains the first-message draft across reconnect", async () => {
  const f = await fixture();
  try {
    f.send();
    for (;;) {
      const report = progress(await f.nextProgress());
      if (report.step === "checking_out" && (report.percent ?? 0) > 0) break;
    }
    f.action("cancel");
    expect(await f.receipt()).toMatchObject({ ok: false, error: "worktree_cancelled" });
    expect(f.h.inputs).toEqual([]);
    expect(await f.runtime.git.listWorktrees(f.h.home)).toHaveLength(1);
    expect((await f.runtime.git.branches(f.h.home)).branches).toEqual(["main"]);
    await f.client.close();
    const reconnected = await connect(f.server.url);
    try {
      reconnected.send({
        type: "worktree.creation.request",
        requestId: "restore",
        commandId: f.draft.id,
        action: "get",
      });
      expect(
        await until(reconnected, (message) => message.type === "worktree.creation.result"),
      ).toMatchObject({
        ok: true,
        progress: { state: "cancelled", cleanupComplete: true, actions: ["retry", "local"] },
      });
      reconnected.send({
        type: "worktree.creation.request",
        requestId: "local",
        commandId: f.draft.id,
        action: "local",
      });
      expect(await until(reconnected, (message) => message.type === "commandResult")).toMatchObject(
        { ok: true },
      );
      await f.h.engine.flush();
      expect(f.h.inputs.map((input) => input.text)).toEqual(["Keep this exact first message"]);
      expect(f.h.sessions[0]?.context.cwd).toBe(await realpath(f.h.home));
    } finally {
      await reconnected.close();
    }
  } finally {
    await f.close();
  }
});

test("don't use worktree during checkout switches to local and sends the queued input once", async () => {
  const f = await fixture();
  try {
    f.send();
    for (;;) {
      const report = progress(await f.nextProgress());
      if (report.step === "checking_out" && (report.percent ?? 0) > 0) break;
    }
    f.action("local");
    expect(await f.receipt()).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.map((input) => input.text)).toEqual(["Keep this exact first message"]);
    expect(f.h.sessions[0]?.context.cwd).toBe(await realpath(f.h.home));
    expect(f.h.store.getThread(ThreadId.parse("progress"))?.details?.mode).toBe("local");
    expect(await f.runtime.git.listWorktrees(f.h.home)).toHaveLength(1);
    expect((await f.runtime.git.branches(f.h.home)).branches).toEqual(["main"]);
    expect(await command(f.client, f.draft.id, f.draft.payload)).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("setup failures expose a fixed error and bounded redacted details, then Retry delivers the original message", async () => {
  const f = await fixture();
  const secret = "ghp_" + "A".repeat(36);
  try {
    await writeFile(
      join(f.h.home, "Makefile"),
      `setup:\n\t@node -e 'for(let i=0;i<250;i++)console.error("line-"+i);console.error("${secret}");require("fs").writeFileSync("generated.txt","setup output");process.exit(1)'\n`,
    );
    await git("git", ["-C", f.h.home, "add", "Makefile"]);
    await git("git", [
      "-C",
      f.h.home,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@ace.local",
      "commit",
      "-m",
      "Fail setup",
    ]);
    f.send();
    let failure: WorktreeCreationProgress;
    for (;;) {
      const report = progress(await f.nextProgress());
      if (report.state === "failed") {
        failure = report;
        break;
      }
    }
    expect(await f.receipt()).toMatchObject({ ok: false, error: "workspace_unavailable" });
    expect(failure.message).toBe(
      "We couldn't create the worktree. Try again or use the local checkout.",
    );
    expect(failure.actions).toEqual(["retry", "local"]);
    expect(failure.steps.map((step) => step.step)).toContain("setup");
    expect(failure.details).toHaveLength(200);
    expect(failure.details.join("\n")).not.toContain(secret);
    expect(failure.details.join("\n")).toContain("line-249");
    expect(f.h.inputs).toEqual([]);
    expect(await f.runtime.git.listWorktrees(f.h.home)).toHaveLength(1);
    await writeFile(join(f.h.home, "Makefile"), "setup:\n\t@echo setup-complete\n");
    await git("git", [
      "-C",
      f.h.home,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@ace.local",
      "commit",
      "-am",
      "Fix setup",
    ]);
    f.action("retry");
    expect(await f.receipt()).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.map((input) => input.text)).toEqual(["Keep this exact first message"]);
  } finally {
    await f.close();
  }
});
