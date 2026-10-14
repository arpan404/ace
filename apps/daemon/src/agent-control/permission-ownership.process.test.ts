import { expect, test } from "vitest";
import { AgentCatalogInput } from "@ace/protocol";
import { setup } from "./test-support.ts";

test("a child cannot widen its captured ceiling after its parent widens", async () => {
  const h = setup();
  const parent = await h.parent("auto-review");
  const child = h.service.delegate(parent, {
    requestId: "narrow",
    task: "inspect",
    role: "reader",
    provider: "codex",
    access: "read-only",
    wait: false,
    estimatedLoad: 0,
  });
  await h.engine.flush();
  expect(h.contexts.get(child.childId)?.permissionMode).toContain(":read-only");
  await h.complete(child.childId, "inspected");
  await h.complete(parent.threadId, "ready");
  expect(
    h.service.command("full", {
      type: "thread.permission.set",
      threadId: parent.threadId,
      access: "full-access",
    }).ok,
  ).toBe(true);
  h.service.command("new-parent-turn", {
    type: "thread.send",
    threadId: parent.threadId,
    input: [{ type: "text", text: "continue" }],
  });
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.permission?.effective).toBe("full-access");
  expect(
    h.service.command("widen", {
      type: "thread.permission.set",
      threadId: child.childId,
      access: "full-access",
    }),
  ).toMatchObject({ ok: false, error: "permission_ceiling_unverifiable" });
  expect(h.store.getThread(child.childId)?.permission?.override).toBe("read-only");
});

test("unverifiable cross-provider policies fail before child creation", async () => {
  const h = setup();
  const parent = await h.parent("read-only");
  expect(() =>
    h.service.delegate(parent, {
      requestId: "cross",
      task: "edit",
      role: "writer",
      provider: "claude",
      access: "full-access",
      wait: false,
      estimatedLoad: 0,
    }),
  ).toThrow();
  expect(h.store.listThreads()).toHaveLength(1);
});

test("after an ancestor narrows, a child's own delegation is held to the narrowed ceiling", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "child");
  await h.engine.flush();
  await h.complete(child.childId, "ready");
  await h.complete(parent.threadId, "ready");
  expect(
    h.service.command("narrow-parent", {
      type: "thread.permission.set",
      threadId: parent.threadId,
      access: "read-only",
    }).ok,
  ).toBe(true);
  h.service.command("apply-narrow-parent", {
    type: "thread.send",
    threadId: parent.threadId,
    input: [{ type: "text", text: "continue" }],
  });
  await h.engine.flush();
  expect(h.store.getThread(parent.threadId)?.permission?.effective).toBe("read-only");
  const catalog = h.service.catalog(
    h.caller(child.childId),
    AgentCatalogInput.parse({ provider: "claude" }),
  );
  expect(catalog.instances.flatMap((instance) => instance.allowedAccessModes)).toEqual([
    "read-only",
  ]);
  const grandchild = h.delegate(h.caller(child.childId), "grandchild");
  await h.engine.flush();
  // Claude's read-only access is its plan mode, whatever the child itself last ran.
  expect(h.contexts.get(grandchild.childId)?.permissionMode).toBe("plan");
});
