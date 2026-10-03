import { expect, test } from "vitest";
import { createAgentControlPort } from "@ace/daemon";
import { setup } from "./test-support.ts";

test("registered canonical thread owners handle metadata after agent authorization", async () => {
  const h = setup(),
    parent = await h.parent();
  const port = createAgentControlPort(h.store, h.service, {
    async thread(_caller, operation, signal) {
      signal.throwIfAborted();
      if (operation.op !== "thread.rename") return { ok: false, code: "unsupported" };
      h.store.appendEvents(
        operation.threadId,
        [{ type: "thread.updated", title: `owner:${operation.title}` }],
        h.clock.now(),
      );
      return { ok: true };
    },
  });
  expect(
    (
      await port.execute(
        parent,
        { op: "thread.rename", threadId: parent.threadId, title: "new" },
        new AbortController().signal,
      )
    ).ok,
  ).toBe(true);
  expect(h.store.getThread(parent.threadId)?.title).toBe("owner:new");
  const child = h.delegate(parent, "child");
  await h.engine.flush();
  expect(
    await port.execute(
      h.caller(child.childId),
      { op: "thread.rename", threadId: parent.threadId, title: "forbidden" },
      new AbortController().signal,
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(h.store.getThread(parent.threadId)?.title).toBe("owner:new");
});
