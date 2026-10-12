import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test.each(["restart", "not_sent", "model_unavailable", "uncertain"] as const)(
  "canonical %s queue attention takes precedence over a done status",
  async (reason) => {
    const f = await daemonFixture();
    try {
      f.daemon.store.appendEvents(
        f.caller.threadId,
        [
          {
            type: "queue.updated",
            revision: 100,
            paused: true,
            reason,
            resumeAt: null,
            pendingCount: 0,
          },
        ],
        f.h.clock.now(),
      );
      const output = await invoke(join(f.h.home, "daemon"), [
        "thread",
        "wait",
        f.caller.threadId,
        "--tree",
        "--json",
      ]);
      expect(output.code, output.stderr).toBe(reason === "uncertain" ? 5 : 2);
      expect(JSON.parse(output.stdout)).toMatchObject({
        status: reason === "uncertain" ? "uncertain" : "needs-human",
        tree: [{ attention: reason }],
      });
    } finally {
      await f.daemon.close();
    }
  },
);

test("a done thread with a stopped empty queue returns needs-human from the CLI", async () => {
  const f = await daemonFixture();
  try {
    const command = f.controls.delegations.command("stop-parent", {
      type: "thread.interrupt",
      threadId: f.caller.threadId,
      cascade: false,
    });
    expect(command.ok).toBe(true);
    await f.daemon.engine?.flush();
    expect(f.daemon.store.getThread(f.caller.threadId)?.status.state).toBe("done");
    const output = await invoke(join(f.h.home, "daemon"), [
      "thread",
      "wait",
      f.caller.threadId,
      "--tree",
      "--json",
    ]);
    expect(output.code, output.stderr).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "needs-human",
      tree: [{ attention: "stopped", queue: { pendingCount: 0 } }],
    });
  } finally {
    await f.daemon.close();
  }
});

test("manually held input returns needs-human even when the provider's previous turn is done", async () => {
  const f = await daemonFixture();
  try {
    const engine = f.daemon.engine;
    if (!engine) throw new Error("Missing engine");
    expect(
      f.controls.delegations.command("pause-parent", {
        type: "queue.pause",
        threadId: f.caller.threadId,
        expectedRevision: engine.queue(f.caller.threadId).revision,
      }).ok,
    ).toBe(true);
    expect(
      f.controls.delegations.command("held-input", {
        type: "thread.send",
        threadId: f.caller.threadId,
        input: [{ type: "text", text: "held" }],
        delivery: "queue",
      }).ok,
    ).toBe(true);
    await engine.flush();
    const output = await invoke(join(f.h.home, "daemon"), [
      "thread",
      "wait",
      f.caller.threadId,
      "--tree",
      "--json",
    ]);
    expect(output.code, output.stderr).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "needs-human",
      tree: [{ attention: "manual", queue: { pendingCount: 1 } }],
    });
  } finally {
    await f.daemon.close();
  }
});

test("unresponsive delegated work is uncertain in public task status", async () => {
  const f = await daemonFixture();
  try {
    const home = join(f.h.home, "daemon");
    const spawned = await invoke(home, [
      "task",
      "spawn",
      "silent",
      "--parent",
      f.caller.threadId,
      "--provider",
      "claude",
      "--json",
    ]);
    const id = ThreadId.parse(
      z.object({ data: z.object({ threadId: z.string() }) }).parse(JSON.parse(spawned.stdout)).data
        .threadId,
    );
    await f.daemon.engine?.flush();
    await f.h.emit(id, { type: "agent.disconnected", agent: "root" });
    await f.daemon.engine?.flush();
    const output = await invoke(home, ["task", "status", id, "--json"]);
    expect(output.code, output.stderr).toBe(5);
    expect(JSON.parse(output.stdout)).toMatchObject({
      state: "unresponsive",
      status: { state: "unresponsive" },
    });
  } finally {
    await f.daemon.close();
  }
});
