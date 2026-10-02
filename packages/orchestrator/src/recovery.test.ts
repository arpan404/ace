import { expect, it } from "vitest";
import { recover, sideBySide } from "./index.ts";
import { artifact, check, complete, fact, setup } from "./test-support.ts";

const file = (path: string) => ({ path, status: "M", additions: 1, deletions: 0, binary: false });

it("recovery refuses a cancel intent when no run cancellation owns it", () => {
  const r = setup("fanout", 1);
  const start = r.initial.intents[0];
  const lane = r.lanes[0];
  if (!start || !lane) throw new Error("Missing start");
  const invalid = { ...start, effect: { type: "cancel", ...fact(lane) } };
  expect(() => recover({ ...r.state, intents: { [start.id]: invalid } })).toThrow(
    "Invalid intent phase",
  );
});
it("recovery refuses a merge intent for an unselected lane", () => {
  const r = setup("fanout", 2);
  const [a, b] = r.lanes;
  if (!a || !b) throw new Error("Missing lanes");
  for (const lane of r.lanes) {
    complete(r.state, lane, r.ctx);
    check(r.state, lane, r.ctx);
  }
  const merge = r.send({ type: "pick", laneId: a.id, merge: true }).intents[0];
  if (!merge) throw new Error("Missing merge");
  const invalid = { ...merge, effect: { ...merge.effect, laneId: b.id } };
  expect(() => recover({ ...r.state, intents: { [merge.id]: invalid } })).toThrow(
    "Invalid intent phase",
  );
});
it("recovery refuses ambiguous check generations and missing required effects", () => {
  const r = setup("fanout", 1);
  const lane = r.lanes[0];
  if (!lane) throw new Error("Missing lane");
  const pending = complete(r.state, lane, r.ctx).intents[0];
  if (!pending) throw new Error("Missing check");
  expect(() =>
    recover({
      ...r.state,
      intents: { ...r.state.intents, duplicate: { ...pending, id: "duplicate" } },
    }),
  ).toThrow("Duplicate intent operation");
  const intents = { ...r.state.intents };
  delete intents[pending.id];
  expect(() => recover({ ...r.state, intents })).toThrow("Missing lifecycle intent");
});
it("side-by-side summaries expose the global row cap and preserve retained changes", () => {
  const comparison = {
    durationMs: 1,
    usage: { tokens: 1, cost: 0 },
    artifact,
    checksPassed: true,
    filesTruncated: false,
    patch: "",
    patchTruncated: false,
  };
  const result = sideBySide([
    {
      ...comparison,
      laneId: "a",
      files: Array.from({ length: 4096 }, (_, i) => file(`file-${i}`)),
    },
    { ...comparison, laneId: "b", files: [file("file-0"), file("overflow")] },
  ]);
  expect(result.truncated).toBe(true);
  expect(result.files).toHaveLength(4096);
  expect(Object.keys(result.files[0]?.lanes ?? {})).toEqual(["a", "b"]);
  expect(result.files.at(-1)?.path).toBe("file-4095");
});
it("recovery refuses a pending check for a different checkpoint than its lane", () => {
  const r = setup("fanout", 1);
  const lane = r.lanes[0];
  if (!lane) throw new Error("Missing lane");
  const pending = complete(r.state, lane, r.ctx).intents[0];
  if (!pending || pending.effect.type !== "check") throw new Error("Missing check");
  const valid = recover(r.state);
  expect(valid.intents.map((intent) => intent.id)).toContain(pending.id);
  const invalid = {
    ...pending,
    effect: {
      ...pending.effect,
      artifact: { ...pending.effect.artifact, checkpoint: "refs/ace/checkpoints/other/1" },
    },
  };
  expect(() =>
    recover({ ...r.state, intents: { ...r.state.intents, [pending.id]: invalid } }),
  ).toThrow("Invalid intent phase");
});
