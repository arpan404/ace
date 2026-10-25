import { expect, test } from "vitest";
import { MachinePendingRequest, ThreadId, type MachineThreadView } from "@ace/protocol";
import { RECHECK_PER_MACHINE, recheckBatches, recheckOutcome } from "./child-recheck.ts";

const view = (changes: Partial<MachineThreadView>): MachineThreadView => ({
  threadId: ThreadId.parse("child-a"),
  state: "done",
  title: "Review",
  elapsedSeconds: 12,
  status: { state: "done" },
  requests: [],
  result: "All tests pass.",
  truncated: false,
  ...changes,
});

test("a settled child running again on its machine reopens", () => {
  expect(
    recheckOutcome(view({}), view({ state: "working", status: { state: "working", agents: 1 } })),
  ).toBe("reopen");
});

test("a settled child waiting on the person there reopens, even if its state reads settled", () => {
  const asking = view({
    requests: [
      MachinePendingRequest.parse({
        threadId: "child-a",
        interactionId: "ask-1",
        request: {
          kind: "question",
          questions: [
            {
              id: "choice",
              text: "Which database?",
              options: [{ id: "pg", label: "Postgres" }],
              multiSelect: false,
            },
          ],
        },
      }),
    ],
  });
  expect(recheckOutcome(view({}), asking)).toBe("reopen");
});

test("changes there that leave its outcome and result alone never repeat the result", () => {
  expect(recheckOutcome(view({}), view({ title: "Renamed", elapsedSeconds: 99 }))).toBe("ignore");
});

test("work that ran there and settled with a new result gives the parent that result", () => {
  expect(recheckOutcome(view({}), view({ result: "Fixed the flaky test." }))).toBe("settle");
  expect(
    recheckOutcome(view({ state: "cancelled", result: "Stopped before it started." }), view({})),
  ).toBe("settle");
});

test("each machine is asked about at most its most recent settled children", () => {
  const rows = [
    ...Array.from({ length: RECHECK_PER_MACHINE + 4 }, (_, index) => ({
      machine: "studio",
      id: `s${index}`,
    })),
    { machine: "laptop", id: "l0" },
  ];
  const batches = recheckBatches(rows);
  expect(batches.get("studio")?.map((row) => row.id)).toEqual(
    rows.slice(0, RECHECK_PER_MACHINE).map((row) => row.id),
  );
  expect(batches.get("laptop")?.map((row) => row.id)).toEqual(["l0"]);
});
