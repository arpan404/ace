import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { setup } from "./test-support.ts";

test("delegates resolve their own provider's manual preset and may select another advertised mode", async () => {
  const h = setup();
  await h.catalog.refresh();
  const workspace = h.store.createWorkspace(h.home, "workspace");
  const created = h.service.command("parent", {
    type: "thread.prepare",
    threadId: ThreadId.parse("parent-root"),
    title: "Parent",
    workspaceId: workspace,
    provider: "codex",
    permissionMode: ":workspace",
  });
  if (!created.ok || !created.threadId) throw new Error("Missing parent");
  expect(
    h.service.command("parent-turn", {
      type: "thread.send",
      threadId: created.threadId,
      input: [{ type: "text", text: "parent" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const parent = h.caller(created.threadId);
  const child = h.delegate(parent, "owned-child");
  await h.engine.flush();
  // The scripted Claude adapter advertises approvals but no native auto review.
  // Its explicit manual preset must not inherit the parent's Codex :workspace mode.
  expect(h.contexts.get(child.childId)?.permissionMode).toBe("default");
  expect(h.store.getThread(child.childId)?.permission).toMatchObject({
    effective: "default",
    override: null,
  });
  expect(
    h.service.command("widen-child", {
      type: "thread.permission.set",
      threadId: child.childId,
      permissionMode: "bypassPermissions",
    }),
  ).toMatchObject({ ok: true });
  expect(h.store.getThread(created.threadId)?.permission?.effective).toBe(":workspace");
  expect(h.store.getThread(child.childId)?.permission?.override).toBe("bypassPermissions");
  expect(h.errors).toEqual([]);
});
