import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { OffshiftRun, type OffshiftEvidenceKind } from "@ace/protocol/offshift";
import { runCard } from "./index.ts";

const kinds: OffshiftEvidenceKind[] = ["automated", "source", "ui", "human", "manual"];
function run(overrides: Partial<OffshiftRun> = {}): OffshiftRun {
  return OffshiftRun.parse({
    id: "feature",
    threadId: ThreadId.parse("00000000-0000-4000-8000-000000000001"),
    outcome: "User can restore an item",
    endpoint: "Verified local change",
    criteria: [
      { id: "restore", description: "Restore persists", requiredKinds: ["automated", "ui"] },
      { id: "audit", description: "Restores are logged", requiredKinds: ["source", "human"] },
    ],
    phase: "verify",
    version: 4,
    blocker: null,
    note: "Observed",
    evidence: [],
    createdAt: 1,
    updatedAt: 9,
    ...overrides,
  });
}
const evidence = (
  criterionId: string,
  kind: OffshiftEvidenceKind,
  result: "pass" | "fail",
  revision: string,
) => ({
  criterionId,
  kind,
  result,
  revision,
  action: "a",
  artifact: "b",
  note: "c",
  recordedAt: 5,
});

test("evidence reads as a current pass, a current failure, a pass at an older revision or nothing", () => {
  const card = runCard(
    run({
      evidence: [
        evidence("restore", "automated", "pass", "r2"),
        evidence("restore", "ui", "fail", "r2"),
        evidence("audit", "source", "pass", "r1"),
      ],
    }),
    "r2",
  );
  expect(card.criteria.map((item) => item.evidence)).toEqual([
    [
      { kind: "automated", state: "pass", recordedAt: 5 },
      { kind: "ui", state: "fail", recordedAt: 5 },
    ],
    [
      { kind: "source", state: "stale", recordedAt: 5 },
      { kind: "human", state: "missing", recordedAt: null },
    ],
  ]);
  expect(card.pending).toEqual([
    { criterionId: "restore", kind: "ui" },
    { criterionId: "audit", kind: "source" },
    { criterionId: "audit", kind: "human" },
  ]);
  expect(card.pendingCount).toBe(3);
});

test("a blocked run carries its blocker, phase and version", () => {
  const card = runCard(run({ blocker: "Need a test account", phase: "implement" }), "r1");
  expect(card).toMatchObject({ blocker: "Need a test account", phase: "implement", version: 4 });
});

test("a run at full capacity yields a card of a few KB that keeps counts and clips long text", () => {
  const long = "雪".repeat(4095) + "😀";
  const criteria = Array.from({ length: 64 }, (_, index) => ({
    id: `criterion-${index}`.padEnd(128, "x"),
    description: long,
    requiredKinds: kinds,
  }));
  const card = runCard(
    run({ outcome: long, endpoint: long, blocker: long, criteria }),
    "r".repeat(512),
  );
  expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(24 * 1024);
  expect(card.criteria).toHaveLength(16);
  expect(card.criteriaCount).toBe(64);
  expect(card.pending).toHaveLength(16);
  expect(card.pendingCount).toBe(320);
  expect(card.outcomeTruncated).toBe(true);
  expect(card.outcome.endsWith("…")).toBe(true);
  expect(card.outcome.length).toBeLessThanOrEqual(512);
  expect(card.criteria[0]?.description.length).toBeLessThanOrEqual(160);
});

test("clipping never splits a surrogate pair and leaves short text whole", () => {
  const card = runCard(run({ outcome: "a".repeat(510) + "😀😀" }), "r1");
  expect(card.outcome).toBe("a".repeat(510) + "…");
  expect(runCard(run(), "r1")).toMatchObject({
    outcome: "User can restore an item",
    outcomeTruncated: false,
  });
});
