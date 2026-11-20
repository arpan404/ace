/*
 * The move's own interrupt (ADR 0191) against a message queued behind the working turn: two real
 * daemons, scripted providers. A process test because the queue, the Stop and the move's close
 * are the source engine's together.
 */
import { chmod, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandId } from "@ace/protocol";
import { expect, it, vi } from "vitest";
import { continueOn, op, sentTo, workingThread } from "./transfer-live-support.ts";
import { git, transferMachines } from "./transfer-test-support.ts";

it("keeps a follow-up queued while the turn works through the move's interrupt", async () => {
  const m = await transferMachines();
  const { threadId } = await workingThread(m);
  const queued = m.source.controls.delegations.command("queued-follow-up", {
    type: "thread.send",
    threadId,
    input: [{ type: "text", text: "Also update the docs" }],
    delivery: "queue",
  });
  expect(queued).toMatchObject({ ok: true });
  await m.source.daemon.engine?.flush();
  await continueOn(m, threadId);
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  // Interrupted between tool calls, as a working turn is.
  expect(m.source.h.interrupts).toContain(threadId);
  const fate = m.source.daemon.engine?.inputFate(threadId, CommandId.parse("queued-follow-up"));
  expect(fate?.state).not.toBe("failed");
  expect(sentTo(m.source, threadId)).not.toContain("Also update the docs");
  expect(m.source.daemon.engine?.queue(threadId).messages).toHaveLength(1);
});

it("explains why a local origin cannot be moved before sending work to the target", async () => {
  const calls: string[] = [];
  const m = await transferMachines({
    sourceGitPolicy: {},
    transport: (inner) => (profile, route, options) => {
      calls.push(op(route));
      return inner(profile, route, options);
    },
  });
  const { threadId } = await workingThread(m, async (path) => {
    await git(path, "remote", "set-url", "origin", pathToFileURL(path).href);
  });

  await continueOn(m, threadId);
  expect(await m.settled()).toMatchObject({
    phase: "failed",
    error: {
      code: "origin_not_cloneable",
      message:
        "This project's origin is a local file path, which another machine can't clone. Push it to a remote, or move it as a folder.",
    },
  });
  expect(calls).not.toContain("begin");
  expect(m.source.h.interrupts).not.toContain(threadId);
});

it("logs an unexpected move failure with its stack and redacts credentials", async () => {
  const m = await transferMachines({
    logs: true,
    transport: (inner) =>
      async function failBegin(profile, route, options) {
        if (op(route) === "begin")
          throw new Error(
            "Unexpected begin failure at https://user:move-log-secret@example.com/repo",
          );
        return inner(profile, route, options);
      },
  });
  const { threadId } = await workingThread(m);

  await continueOn(m, threadId);
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "failed", error: { code: "transfer_failed" } });
  await vi.waitFor(
    async () => {
      const directory = join(m.source.h.home, "daemon", "logs");
      const files = await readdir(directory);
      const logs = (
        await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")))
      ).join("\n");
      const failure =
        logs.split("\n").find((line) => line.includes("Unexpected transfer failure")) ?? "";
      expect(failure).toContain(transfer.transferId);
      expect(failure).toContain("Unexpected begin failure");
      expect(failure).toMatch(/"stack":.*failBegin/);
      expect(failure).not.toContain("move-log-secret");
    },
    { timeout: 5_000 },
  );
});

it.each(["outside project roots", "missing", "unwritable"])(
  "refuses a landing folder that is %s without interrupting the source agent",
  async (problem) => {
    const m = await transferMachines();
    const { threadId } = await workingThread(m);
    const parent =
      problem === "outside project roots"
        ? m.sourceRoot
        : problem === "missing"
          ? join(m.targetRoot, "missing")
          : m.targetRoot;
    if (problem === "unwritable") await chmod(parent, 0o500);
    try {
      await m.here.command({
        type: "thread.continueOn",
        threadId,
        hostId: m.targetHostId,
        includeChanges: true,
        parent,
      });

      expect(await m.settled()).toMatchObject({
        phase: "failed",
        error: { code: "parent_not_allowed" },
      });
      expect(m.source.h.interrupts).not.toContain(threadId);
      expect(m.source.daemon.store.getThread(threadId)?.status.state).toBe("working");
    } finally {
      if (problem === "unwritable") await chmod(parent, 0o700);
    }
  },
);
