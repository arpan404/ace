import { expect, test } from "vitest";
import { setup } from "./test-support.ts";

test("Deck delegates retain display ownership and cannot widen their parent's permission mode", async () => {
  const h = setup();
  const workspace = h.store.createWorkspace(h.home, "workspace");
  const deck = { deckId: "deck", runId: "run", workspaceId: workspace, role: "root" as const };
  const created = h.service.command("deck-parent", {
    type: "thread.prepare",
    workspaceId: workspace,
    provider: "codex",
    deck,
    permissionMode: "ask",
  });
  if (!created.ok || !created.threadId) throw new Error("Missing parent");
  expect(
    h.service.command("deck-parent-turn", {
      type: "thread.send",
      threadId: created.threadId,
      input: [{ type: "text", text: "parent" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const parent = h.caller(created.threadId);
  const child = h.delegate(parent, "owned-child");
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.deck).toEqual({ ...deck, role: "delegate" });
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
