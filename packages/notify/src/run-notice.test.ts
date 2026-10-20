import { afterEach, expect, it } from "vitest";
import { OffshiftRunCard } from "@ace/protocol/offshift";
import { setup } from "./notify.test-helper.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture() {
  const f = setup();
  fixtures.push(f);
  return f;
}

function card(input: Partial<OffshiftRunCard> = {}): OffshiftRunCard {
  return OffshiftRunCard.parse({
    id: "login",
    outcome: "Sign-in shows an error for a bad password",
    outcomeTruncated: false,
    endpoint: "PR",
    phase: "verify",
    blocker: null,
    version: 3,
    updatedAt: 1,
    revision: "r1",
    criteria: [],
    criteriaCount: 1,
    pending: [{ criterionId: "error", kind: "ui" }],
    pendingCount: 1,
    next: "Record ui evidence for `error` at revision r1.",
    ...input,
  });
}
/** The desktop's notices, one per settle. */
const desktop = (f: ReturnType<typeof fixture>) =>
  f.deliveries.filter((d) => d.device.id === f.desktop).map((d) => d.notification);

it("a tree that settles with its run open says where the run stopped and what is next", async () => {
  const f = fixture();
  f.start();
  f.append([{ type: "offshift.updated", card: card() }]);
  f.end();
  await f.flush();
  expect(desktop(f)).toEqual([
    expect.objectContaining({
      status: "done",
      run: { outcome: "stopped", phase: "verify" },
      message: "Run stopped at Verify: Record ui evidence for `error` at revision r1.",
    }),
  ]);
});

it("a blocked run names its blocker only once the tree settles", async () => {
  const f = fixture();
  f.start();
  f.append([{ type: "offshift.updated", card: card({ blocker: "Which locale is the default?" }) }]);
  await f.flush();
  // Still working: the agent asks the person itself; the record alone notifies nobody.
  expect(desktop(f)).toEqual([]);
  f.end();
  await f.flush();
  expect(desktop(f)).toEqual([
    expect.objectContaining({
      run: { outcome: "blocked", phase: "verify" },
      message: "Run blocked at Verify: Which locale is the default?",
    }),
  ]);
});

it("a delivered run is announced once per run write, then settles say only finished", async () => {
  const f = fixture();
  const delivered = card({ phase: "delivery", pending: [], pendingCount: 0, version: 7 });
  f.start();
  f.append([{ type: "offshift.updated", card: delivered }]);
  f.end();
  await f.flush();
  f.start();
  f.end();
  await f.flush();
  const [first, second] = desktop(f);
  expect(first).toMatchObject({ run: { outcome: "delivered" }, message: "Run delivered" });
  expect(second?.status).toBe("done");
  expect(second?.run).toBeUndefined();
  // A new write of the run is news again.
  f.start();
  f.append([{ type: "offshift.updated", card: { ...delivered, version: 8 } }]);
  f.end();
  await f.flush();
  expect(desktop(f)[2]).toMatchObject({ run: { outcome: "delivered" } });
});

it("an open run is named on every settle while it stays open, one notice per settle", async () => {
  const f = fixture();
  f.start();
  f.append([{ type: "offshift.updated", card: card() }]);
  f.end();
  await f.flush();
  // The same done status again is not a settle: nothing new.
  f.append([{ type: "thread.updated", title: "Renamed" }]);
  await f.flush();
  expect(desktop(f)).toHaveLength(1);
  f.start();
  f.end();
  await f.flush();
  expect(desktop(f).map((notice) => notice.run?.outcome)).toEqual(["stopped", "stopped"]);
});

it("a failed tree keeps its failure notice, without run wording", async () => {
  const f = fixture();
  f.start();
  f.append([{ type: "offshift.updated", card: card() }]);
  f.end("failed");
  await f.flush();
  expect(desktop(f)).toEqual([expect.objectContaining({ status: "failed" })]);
  expect(desktop(f)[0]?.run).toBeUndefined();
});
