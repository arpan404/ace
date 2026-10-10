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

test("automatic title generation replaces a provisional title once and preserves later manual titles", async () => {
  const h = setup();
  const parent = await h.parent();
  const port = createAgentControlPort(h.store, h.service);
  const rename = (title: string) =>
    port.execute(
      parent,
      {
        op: "thread.rename",
        threadId: parent.threadId,
        title,
        onlyIfProvisional: true,
      },
      new AbortController().signal,
    );
  expect(h.store.getThread(parent.threadId)?.titleSource).toBe("provisional");
  expect(await rename("Review deployment plan")).toEqual({ ok: true });
  expect(await rename("Late generated title")).toEqual({ ok: false, code: "not_ready" });
  expect(h.store.getThread(parent.threadId)?.title).toBe("Review deployment plan");
  h.store.appendEvents(parent.threadId, [
    { type: "thread.updated", title: "My chosen title", titleSource: "person" },
  ]);
  expect(await rename("Generated replacement")).toEqual({ ok: false, code: "not_ready" });
  expect(h.store.getThread(parent.threadId)?.title).toBe("My chosen title");
});
