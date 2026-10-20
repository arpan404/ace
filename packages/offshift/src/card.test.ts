import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import {
  OffshiftRun,
  OffshiftRunCard,
  type OffshiftAuthor,
  type OffshiftEvidenceKind,
} from "@ace/protocol/offshift";
import { runCard } from "./index.ts";

const kinds: OffshiftEvidenceKind[] = ["automated", "source", "ui", "human", "manual"];
const ownerThread = ThreadId.parse("00000000-0000-4000-8000-000000000001");
const owner = { threadId: ownerThread, provider: "codex" as const, model: "gpt-5" };
const reviewer = {
  threadId: ThreadId.parse("00000000-0000-4000-8000-000000000002"),
  provider: "claude" as const,
  model: "opus",
};
function run(overrides: Partial<OffshiftRun> = {}): OffshiftRun {
  return OffshiftRun.parse({
    id: "feature",
    threadId: ownerThread,
    outcome: "User can restore an item",
    endpoint: "Verified local change",
    criteria: [
      { id: "restore", description: "Restore persists", requiredKinds: ["automated", "ui"] },
      { id: "audit", description: "Restores are logged", requiredKinds: ["source", "human"] },
    ],
    owner,
    roles: {},
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
  by: OffshiftAuthor = owner,
) => ({
  criterionId,
  kind,
  result,
  revision,
  action: "a",
  artifact: "b",
  note: "c",
  recordedAt: 5,
  by,
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
  const by = { provider: "codex", model: "gpt-5" };
  expect(card.criteria.map((item) => item.evidence)).toEqual([
    [
      { kind: "automated", state: "pass", recordedAt: 5, by },
      { kind: "ui", state: "fail", recordedAt: 5, by },
    ],
    [
      { kind: "source", state: "stale", recordedAt: 5, by },
      { kind: "human", state: "missing", recordedAt: null, by: null },
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
  const steps = Array.from({ length: 24 }, (_, index) => ({
    id: `step-${index}`.padEnd(128, "x"),
    title: "雪".repeat(160),
    phase: "verify" as const,
    state: "skipped" as const,
    note: "雪".repeat(1024),
  }));
  const card = runCard(
    run({ outcome: long, endpoint: long, blocker: long, criteria, steps }),
    "r".repeat(512),
  );
  // Raised from 24 KB for Offshift steps: 24 steps with clipped skip reasons add up to 27 KB.
  expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(52 * 1024);
  expect(card.steps).toHaveLength(24);
  expect(card.steps[0]?.reason?.length).toBe(160);
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

test("an independent criterion's own-model pass reads not independent until another provider passes it", () => {
  const criteria = [
    {
      id: "restore",
      description: "Restore persists",
      requiredKinds: ["ui" as const],
      independent: true,
    },
  ];
  const own = runCard(run({ criteria, evidence: [evidence("restore", "ui", "pass", "r1")] }), "r1");
  expect(own.criteria[0]).toMatchObject({
    independent: true,
    evidence: [{ state: "not_independent", by: { provider: "codex", model: "gpt-5" } }],
  });
  expect(own.pending).toEqual([{ criterionId: "restore", kind: "ui", needs: "independent" }]);
  const checked = runCard(
    run({ criteria, evidence: [evidence("restore", "ui", "pass", "r1", reviewer)] }),
    "r1",
  );
  expect(checked.criteria[0]?.evidence[0]).toMatchObject({
    state: "pass",
    by: { provider: "claude", model: "opus" },
  });
  expect(checked.pendingCount).toBe(0);
});

test("the card names each role from the run, falling back to the project default", () => {
  const card = runCard(run({ roles: { build: { provider: "codex", model: "gpt-5" } } }), "r1", {
    build: { provider: "cursor" },
    verify: { provider: "claude", effort: "high" },
  });
  expect(card.roles).toEqual([
    { role: "build", source: "run", provider: "codex", model: "gpt-5" },
    { role: "verify", source: "project", provider: "claude", effort: "high" },
  ]);
  expect(runCard(run(), "r1").roles).toEqual([]);
});

test("the card names the playbook the run started from, and a card stored before it still reads", () => {
  expect(runCard(run({ playbook: "fix" }), "r").playbook).toBe("fix");
  expect(runCard(run(), "r").playbook).toBeUndefined();
  const { playbook: _playbook, next: _next, ...older } = runCard(run({ playbook: "fix" }), "r");
  expect(OffshiftRunCard.parse(older)).toMatchObject({ id: "feature", phase: "verify" });
});

test("the card carries the run's next step as worded at the write", () => {
  expect(runCard(run(), "r", undefined, "Advance to review.").next).toBe("Advance to review.");
});
