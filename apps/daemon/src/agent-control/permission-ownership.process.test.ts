import { expect, test } from "vitest";
import { setup } from "./test-support.ts";

test("a child cannot widen its captured ceiling after its parent widens", async () => {
  const h = setup();
  const parent = await h.parent(":workspace");
  const child = h.service.delegate(parent, {
    requestId: "narrow",
    task: "inspect",
    role: "reader",
    provider: "codex",
    permissionMode: ":read-only",
    wait: false,
    estimatedLoad: 0,
  });
  await h.engine.flush();
  expect(h.contexts.get(child.childId)?.permissionMode).toBe(":read-only");
  await h.complete(child.childId, "inspected");
  await h.complete(parent.threadId, "ready");
  expect(
    h.service.command("full", {
      type: "thread.permission.set",
      threadId: parent.threadId,
      permissionMode: ":danger-full-access",
    }).ok,
  ).toBe(true);
  h.service.command("new-parent-turn", {
    type: "thread.send",
    threadId: parent.threadId,
    input: [{ type: "text", text: "continue" }],
  });
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.permission?.effective).toBe(":danger-full-access");
  expect(
    h.service.command("widen", {
      type: "thread.permission.set",
      threadId: child.childId,
      permissionMode: ":danger-full-access",
    }),
  ).toMatchObject({ ok: false, error: "permission_ceiling_unverifiable" });
  expect(h.store.getThread(child.childId)?.permission?.override).toBe(":read-only");
});

test("unverifiable cross-provider policies fail before child creation", async () => {
  const h = setup();
  const parent = await h.parent(":read-only");
  expect(() =>
    h.service.delegate(parent, {
      requestId: "cross",
      task: "edit",
      role: "writer",
      provider: "claude",
      permissionMode: "bypassPermissions",
      wait: false,
      estimatedLoad: 0,
    }),
  ).toThrow();
  expect(h.store.listThreads()).toHaveLength(1);
});
