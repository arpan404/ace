import { expect, test } from "vitest";
import { WorkspaceId } from "@ace/protocol";
import { setup } from "./test-support.ts";

test("receipt capacity survives settlement and restart while failed preparation releases its reservation", async () => {
  // Lower the host-owned cap to exercise the production boundary without creating 10,000 threads.
  const h = setup({}, undefined, false, undefined, false, undefined, 2);
  const parent = await h.parent();
  expect(() =>
    h.service.prepareInWorkspace(
      parent,
      {
        requestId: "bad-workspace",
        provider: "claude",
        task: "work",
        role: "worker",
        wait: false,
        estimatedLoad: 0,
      },
      WorkspaceId.parse("missing"),
    ),
  ).toThrow(/workspace_not_found/);
  const first = h.delegate(parent, "first");
  await h.engine.flush();
  await h.complete(first.childId, "first result");
  const second = h.delegate(parent, "second");
  await h.engine.flush();
  await h.complete(second.childId, "second result");
  h.restartOwner();
  const another = await h.parent();
  expect(() => h.delegate(another, "over-capacity")).toThrow(/journal capacity/);
  expect(h.store.listThreads()).toHaveLength(4);
});
