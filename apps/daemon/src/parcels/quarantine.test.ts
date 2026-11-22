import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../store.ts";
import { quarantineOnOrgHost } from "./quarantine.ts";
import { ParcelRows, type OutRoute, type OutRow } from "./store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const out = (parcelId: string, route: OutRoute): OutRow => ({
  parcelId,
  fromThread: "t_parent",
  fromAgent: "a_1",
  toThread: "t_child",
  route,
  facts: { parcelId, name: "data.csv", size: 10, sha256: "0".repeat(64), fromTitle: "Parent" },
  state: route === "outbox" ? "waiting" : "sending",
  held: 0,
  attempts: 0,
  nextAt: 0,
  createdAt: 1,
  updatedAt: 1,
  delivered: false,
});

it("an org host fails every parcel queued for another machine before it was enrolled, and keeps local ones", () => {
  // ADR 0209 §4.2: nothing leaves an org host by a machine route, queued earlier or not.
  const home = mkdtempSync(join(tmpdir(), "ace-parcels-"));
  homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  const rows = new ParcelRows(store);
  rows.insertOut(out("p_push", "push"));
  rows.insertOut(out("p_outbox", "outbox"));
  rows.insertOut(out("p_local", "local"));
  const settled: string[] = [];
  expect(
    quarantineOnOrgHost(rows, (parcelId, state, reason) => {
      settled.push(`${parcelId}:${state}`);
      rows.settleOut(parcelId, state, 2, reason);
    }),
  ).toBe(2);
  expect(settled.toSorted()).toEqual(["p_outbox:failed", "p_push:failed"]);
  expect(rows.out("p_local")?.state).toBe("sending");
  // Settled once: the next pass finds nothing left to fail.
  expect(quarantineOnOrgHost(rows, () => settled.push("again"))).toBe(0);
  store.close();
});
