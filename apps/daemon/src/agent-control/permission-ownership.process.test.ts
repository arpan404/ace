import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { setup } from "./test-support.ts";

test("delegates cannot widen their parent's permission mode", async () => {
  const h = setup();
  await h.catalog.refresh();
  const workspace = h.store.createWorkspace(h.home, "workspace");
  const created = h.service.command("parent", {
    type: "thread.prepare",
    threadId: ThreadId.parse("parent-root"),
    title: "Parent",
    workspaceId: workspace,
    provider: "codex",
    permissionMode: "ask",
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
  expect(h.contexts.get(child.childId)?.permissionMode).toBe("ask");
  expect(h.store.getThread(child.childId)?.permission?.effective).toBe("ask");
  expect(
    h.service.command("widen-child", {
      type: "thread.permission.set",
      threadId: child.childId,
      permissionMode: "full-access",
    }),
  ).toMatchObject({ ok: false, error: "permission_exceeds_parent" });
  expect(h.errors).toEqual([]);
});
