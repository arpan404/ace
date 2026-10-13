import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { readThreadTree } from "./thread-tree.ts";
import { treeOutcome } from "./work-outcome.ts";

test("a tree with a persisted working child is never complete while agent control is unavailable", async () => {
  const f = await daemonFixture();
  try {
    const engine = f.daemon.engine;
    if (!engine) throw new Error("Engine unavailable");
    const delegated = await f.call({
      op: "delegate_task",
      requestId: "working-child",
      task: "Keep working",
      role: "delegate",
      provider: "claude",
      wait: false,
      estimatedLoad: 0,
    });
    const child = z.object({ data: z.object({ threadId: ThreadId }) }).parse(delegated)
      .data.threadId;
    await engine.flush();
    const parent = ThreadId.parse(f.caller.threadId);
    expect(f.daemon.store.getThread(child)?.status.state).toBe("working");

    // Agent control not started yet (or failed): the child's facts are not ready.
    const unready = readThreadTree({ store: f.daemon.store, services: { engine } }, parent);
    expect(unready).toBeUndefined();

    const ready = readThreadTree(
      { store: f.daemon.store, services: { engine, agentControl: f.controls } },
      parent,
    );
    expect(ready?.map((member) => member.threadId)).toEqual([parent, child]);
    expect(ready && treeOutcome(ready)).toBeUndefined();

    // A thread that never delegated is its whole tree even without agent control.
    const alone = readThreadTree({ store: f.daemon.store, services: { engine } }, child);
    expect(alone?.map((member) => member.threadId)).toEqual([child]);
    expect(alone && treeOutcome(alone)).toBeUndefined();
  } finally {
    await f.daemon.close();
  }
});
