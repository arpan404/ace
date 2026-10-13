import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { end } from "./engine/test-support.ts";
import { invoke } from "./cli-test-support.ts";

type Fixture = Awaited<ReturnType<typeof daemonFixture>>;

async function spawn(f: Fixture, name: string) {
  const result = await f.call({
    op: "delegate_task",
    requestId: name,
    provider: "claude",
    task: `Do ${name}`,
    role: "worker",
    wait: false,
    estimatedLoad: 0,
  });
  await f.daemon.engine?.flush();
  return z.object({ threadId: ThreadId }).parse(result.data).threadId;
}
async function emit(f: Fixture, thread: ThreadId, ...facts: Fact[]) {
  const context = f.h.contexts.get(thread);
  if (!context) throw new Error("Missing native session");
  context.onFrame(f.h.frames.frame(...facts));
  await f.daemon.engine?.flush();
}
const finish = (f: Fixture, thread: ThreadId) =>
  emit(
    f,
    thread,
    {
      type: "item.upsert",
      agent: "root",
      item: "answer",
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "finished" }],
        complete: true,
      },
    },
    end,
  );

test("waiting on several tasks exits 0 when settled, 2 for a request, 3 on timeout", async () => {
  const f = await daemonFixture();
  try {
    const home = join(f.h.home, "daemon");
    const [first, second, asker, worker] = [
      await spawn(f, "first"),
      await spawn(f, "second"),
      await spawn(f, "asker"),
      await spawn(f, "worker"),
    ];
    await finish(f, first);
    await finish(f, second);
    await emit(f, asker, {
      type: "interaction.opened",
      agent: "root",
      interaction: "ask",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "pick",
            text: "Which one?",
            options: [{ id: "a", label: "A" }],
            multiSelect: false,
            allowOther: false,
          },
        ],
      },
    });

    const all = await invoke(home, ["task", "wait", first, second, "--json"]);
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout)).toMatchObject({
      mode: "all",
      status: "ok",
      pending: [],
      threads: [{ status: "ok" }, { status: "ok" }],
    });

    const any = await invoke(home, ["thread", "wait", worker, first, "--any", "--json"]);
    expect(any.code, any.stderr).toBe(0);
    expect(JSON.parse(any.stdout)).toMatchObject({
      mode: "any",
      status: "ok",
      threads: [{ threadId: first }],
      pending: [worker],
    });

    const human = await invoke(home, ["task", "wait", worker, asker, "--json"]);
    expect(human.code, human.stderr).toBe(2);
    expect(JSON.parse(human.stdout)).toMatchObject({
      status: "needs-human",
      threads: [{ threadId: asker, status: "needs-human" }],
    });

    const timeout = await invoke(home, [
      "task",
      "wait",
      first,
      worker,
      "--timeout",
      "1s",
      "--json",
    ]);
    expect(timeout.code, timeout.stderr).toBe(3);
    expect(JSON.parse(timeout.stdout)).toMatchObject({ ok: false, status: "timeout" });

    const conflicting = await invoke(home, ["task", "wait", first, "--any", "--all", "--json"]);
    expect(conflicting.code).toBe(4);
  } finally {
    await f.daemon.close();
  }
});
