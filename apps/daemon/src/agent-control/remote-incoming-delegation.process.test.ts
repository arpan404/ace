import { expect, test } from "vitest";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import { remoteTarget } from "./remote-target-test-support.ts";

test("an incoming remote task delegates on the target like any local root", async () => {
  const f = await remoteTarget();
  const result = await f.target.controls.port.execute(
    f.caller,
    {
      op: "delegate_task",
      requestId: "delegate",
      provider: "claude",
      model: "chosen-model",
      role: "Worker",
      task: "Work",
      wait: false,
      estimatedLoad: 0,
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: true });
  const child = z.object({ threadId: ThreadId }).parse(result.data).threadId;
  await f.target.daemon.engine?.flush();
  expect(f.target.daemon.store.getThread(child)?.status.state).toBe("working");
  expect(f.target.daemon.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");
});
