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
test("native snapshots append aggregate suffixes once and keep the first exact input", () => {
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
  expect(shell(h).call.detail).toMatchObject({ output: { tail: "alphabetalate" } });
  const first = shell(h).call.raw[0];
  expect(first && "data" in first ? first.data : undefined).toEqual(initial);
  expect(
    h.history
      .flatMap((e) => (e.type === "item.delta" && e.field === "output" ? [e.append] : []))
      .join(""),
  ).toBe("alphabetalate");
  reconcile(snapshot("", false, {}));
  expect(shell(h).complete).toBe(true);
  expect(shell(h).call.status).toBe("succeeded");
  expect(h.view.status.state).toBe("done");
});
test("a growing native aggregate appends only its missing suffix", () => {
  const h = harness();
  h.see();
  h.start();
  for (const output of ["partial", "partialmore"])
    h.send({
      type: "item.reconciled",
      agent: "root",
      item: "shell",
      draft: snapshot(output, output === "partialmore", {}),
    });
  expect(shell(h).call.detail).toMatchObject({ output: { tail: "partialmore" } });
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
  expect(shell(h).call.detail).toMatchObject({ output: { tail: "late" } });
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
  expect(shell(h).call.detail).toMatchObject({ output: { tail: "original" } });
  const rejected = Object.values(h.view.items).filter(
    (i) => i.type === "notice" && i.raw.some((r) => r.type === "core.rejected_fact"),
  );
  expect(rejected).toHaveLength(2);
});

test("large Unicode snapshots preserve streamed bytes across repeated completions and late output", () => {
  const h = harness();
  h.see();
  h.start();
  const aggregate = "🙂".repeat(3000);
  const reconcile = () =>
    h.send({
      type: "item.reconciled",
      agent: "root",
      item: "shell",
      draft: snapshot(aggregate, true, {}),
    });
  reconcile();
  h.end();
  h.send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: "late" });
  reconcile();
  reconcile();
  const chunks = h.history.flatMap((e) =>
    e.type === "item.delta" && e.field === "output" ? [e.append] : [],
  );
  expect(chunks.join("")).toBe(aggregate + "late");
  expect(
    chunks.every((chunk) => Buffer.byteLength(chunk) <= 4096 && !chunk.includes("\uFFFD")),
  ).toBe(true);
  expect(shell(h).call.detail).toMatchObject({ output: { bytes: 12004, truncated: true } });
  expect(h.view.status.state).toBe("done");
});

test("a nonextending completion preserves observed output and retains the authoritative aggregate as raw", () => {
  const h = harness();
  h.see();
  h.start();
  h.send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: "beta" });
  const native = { aggregatedOutput: "alphabeta", status: "completed" };
  h.send({
    type: "item.reconciled",
    agent: "root",
    item: "shell",
    draft: snapshot("alphabeta", true, native),
  });
  h.end();
  expect(shell(h).complete).toBe(true);
  expect(shell(h).call.detail).toMatchObject({ output: { tail: "beta", bytes: 4 } });
  expect(
    shell(h).call.raw.some((r) => "data" in r && JSON.stringify(r.data) === JSON.stringify(native)),
  ).toBe(true);
  expect(
    h.history
      .flatMap((e) => (e.type === "item.delta" && e.field === "output" ? [e.append] : []))
      .join(""),
  ).toBe("beta");
  expect(h.view.status.state).toBe("done");
});
