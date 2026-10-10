import { expect, test } from "vitest";
import { replay } from "./translator-test-support.ts";

test("an unexpected idle host exit does not warn about nonexistent unfinished work", () => {
  const run = replay();
  run.frame("result", { status: "finished" });
  run.frame("host-exit", { deliberate: false });
  expect(Object.values(run.state.items).filter((item) => item.type === "notice")).toEqual([]);
});

test("an unexpected exit with active work gives a readable warning", () => {
  const run = replay();
  run.frame("host-exit", { deliberate: false });
  expect(
    Object.values(run.state.items).flatMap((item) => (item.type === "notice" ? [item.text] : [])),
  ).toEqual(["Cursor stopped unexpectedly. Unfinished work needs your attention."]);
});

test("snapshot ambiguity retains evidence without showing SDK internals to the person", () => {
  const run = replay();
  run.frame("snapshot", { items: [{ uuid: "native-root:0", futureField: { opaque: true } }] });
  expect(run.diagnostics.some((raw) => JSON.stringify(raw.data).includes("futureField"))).toBe(
    true,
  );
  expect(
    Object.values(run.state.items).flatMap((item) =>
      item.type === "notice" && !item.raw?.some((raw) => raw.type === "native-notice")
        ? [item.text]
        : [],
    ),
  ).toEqual([]);
});
