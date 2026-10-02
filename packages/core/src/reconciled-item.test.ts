import { expect, test } from "vitest";
import { harness } from "./test-helper.ts";
import type { ItemDraft } from "./index.ts";
const snapshot = (output: string, complete: boolean, input: unknown): ItemDraft => ({
  type: "tool_call",
  complete,
  call: {
    kind: "shell",
    status: complete ? "succeeded" : "running",
    detail: { kind: "shell", command: "loop", output },
    raw: [{ type: "native", data: input }],
  },
});
const shell = (h: ReturnType<typeof harness>) => {
  const item = h.item("shell");
  if (item?.type !== "tool_call" || item.call.detail.kind !== "shell")
    throw new Error("Shell missing");
  return item;
};
test("native snapshots replace aggregates once and keep the first exact input", () => {
  const h = harness();
  h.see();
  h.start();
  const initial = { aggregatedOutput: "alpha", vendor: { input: "original" } };
  const reconcile = (draft: ItemDraft) =>
    h.send({ type: "item.reconciled", agent: "root", item: "shell", draft });
  reconcile(snapshot("alpha", false, initial));
  h.send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: "beta" });
  reconcile(snapshot("alphabeta", true, { aggregatedOutput: "alphabeta" }));
  h.end();
  h.send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: "late" });
  reconcile(snapshot("alphabeta", true, { aggregatedOutput: "alphabeta" }));
  expect(shell(h).call.detail).toMatchObject({ output: "alphabetalate" });
  expect(shell(h).call.raw[0]?.data).toEqual(initial);
  reconcile(snapshot("", false, {}));
  expect(shell(h).complete).toBe(true);
  expect(shell(h).call.status).toBe("succeeded");
  expect(h.view.status.state).toBe("done");
});
test("a changed native aggregate replaces earlier output rather than concatenating it", () => {
  const h = harness();
  h.see();
  h.start();
  for (const output of ["partial", "corrected"])
    h.send({
      type: "item.reconciled",
      agent: "root",
      item: "shell",
      draft: snapshot(output, output === "corrected", {}),
    });
  expect(shell(h).call.detail).toMatchObject({ output: "corrected" });
});
test("late output cannot attach a live shell task to a completed item", () => {
  const h = harness();
  h.see();
  h.start();
  h.send({
    type: "item.reconciled",
    agent: "root",
    item: "shell",
    draft: snapshot("final", true, {}),
  });
  h.end();
  h.background();
  expect(h.view.status.state).toBe("done");
  expect(Object.values(h.view.tasks)).toEqual([]);
});
test("output for a missing shell after turn end creates live work until completion", () => {
  const h = harness();
  h.see();
  h.start();
  h.end();
  h.send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: "late" });
  h.background();
  expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  h.send({
    type: "item.reconciled",
    agent: "root",
    item: "shell",
    draft: snapshot("late", true, {}),
  });
  h.send({ type: "background.ended", task: "task", status: "completed" });
  expect(shell(h).call.detail).toMatchObject({ output: "late" });
  expect(h.view.status.state).toBe("done");
});
test("reconciliation rejects foreign owners and malformed native drafts without corrupting items", () => {
  const h = harness();
  h.see();
  h.start();
  h.send({
    type: "item.reconciled",
    agent: "root",
    item: "shell",
    draft: snapshot("original", true, {}),
  });
  h.see("child", "root");
  h.send({
    type: "item.reconciled",
    agent: "child",
    item: "shell",
    draft: snapshot("foreign", false, {}),
  });
  h.send({
    type: "item.reconciled",
    agent: "root",
    item: "shell",
    draft: { type: "tool_call", call: { kind: "shell", detail: { kind: "shell", output: 1 } } },
  });
  expect(shell(h).call.detail).toMatchObject({ output: "original" });
  const rejected = Object.values(h.view.items).filter(
    (i) => i.type === "notice" && i.raw.some((r) => r.type === "core.rejected_fact"),
  );
  expect(rejected).toHaveLength(2);
});
