import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { quick, setUp } from "./spade-test-host.ts";
import type { SpadeListRow } from "./spade-rows.ts";

/*
 * What a runtime keeps for the next launch's first frame, before that launch's runtime starts
 * (`InboxCheckpoint.swift`): the Spade tab, and its bots as they read until confirmed again.
 */

type Kept = { type: string; shown: boolean; list: { rows: SpadeListRow[] | null } }[];

/** The latest checkpoint the runtime wrote. */
function written() {
  const writes: Kept[] = [];
  return { writes, checkpoint: (json: string) => void writes.push(JSON.parse(json) as Kept) };
}

test("the next launch shows the Spade tab with the bots it last read, none working until read again", async () => {
  const kept = written();
  const { patches } = await setUp(
    (fake) => {
      fake.addAgent({ name: "Spade", kind: "main" });
      fake.addAgent({ name: "Busy", state: "working", status: "Reading the docs" });
    },
    quick,
    kept,
  );
  // The runtime itself shows Busy working.
  await until(() => patches.state?.list.rows?.some((row) => row.state === "working"));

  const [state] = await until(() => kept.writes.at(-1));

  expect(state).toMatchObject({ type: "spade.state", shown: true });
  expect(state?.list.rows?.map((row) => [row.name, row.line])).toEqual([
    ["Spade", "Checking for changes"],
    ["Busy", "Checking for changes"],
  ]);
  expect(
    state?.list.rows?.some((row) => row.state === "working" || row.state === "needs-you"),
  ).toBe(false);
});

test("a machine that stops showing Spade keeps the tab hidden at the next launch", async () => {
  const kept = written();
  const { daemon } = await setUp(() => {}, quick, kept);
  await until(() => kept.writes.at(-1)?.[0]?.shown === true);

  daemon.spade.setStatus({ state: "off", hidden: true });

  await until(() => kept.writes.at(-1)?.[0]?.shown === false);
  expect(kept.writes.at(-1)?.[0]?.list.rows).toBeNull();
});
