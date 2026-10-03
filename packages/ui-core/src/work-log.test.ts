import { Item, type ToolCall } from "@ace/protocol";
import { expect, test } from "vitest";
import { describeStep, summarizeWork, workCounts, workLogHeadline } from "./work-log.ts";

let ids = 0;
const call = (
  detail: ToolCall["detail"],
  status: ToolCall["status"],
  at: number,
  endedAt?: number,
): Item => {
  const id = `item-${++ids}`;
  return Item.parse({
    id,
    agentId: "root",
    createdAt: at,
    complete: status !== "running",
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: detail.kind,
      title: `${detail.kind} call`,
      status,
      detail,
      startedAt: at,
      ...(endedAt === undefined ? {} : { endedAt }),
      raw: [],
    },
  });
};

test("a finished turn reads as files explored, commands run and files edited", () => {
  const items = [
    call({ kind: "file.read", path: "src/a.ts" }, "succeeded", 0, 1000),
    call({ kind: "file.read", path: "src/a.ts" }, "succeeded", 1000, 2000),
    call({ kind: "file.read", path: "src/b.ts" }, "succeeded", 2000, 3000),
    call({ kind: "shell", command: "bun run test", exitCode: 0 }, "succeeded", 3000, 9000),
    call(
      {
        kind: "file.edit",
        changes: [{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }],
      },
      "succeeded",
      9000,
      12_000,
    ),
  ];
  const summary = summarizeWork(items);
  expect(summary.running).toBe(false);
  expect(summary.endedAt - summary.startedAt).toBe(12_000);
  expect(workCounts(summary)).toBe("Explored 2 files · Ran 1 command · Edited 1 file");
});

test("a step in flight keeps the log running and names what it is doing", () => {
  const summary = summarizeWork([
    call({ kind: "file.read", path: "src/a.ts" }, "succeeded", 0, 1000),
    call({ kind: "shell", command: "bun run build" }, "running", 1000),
  ]);
  expect(summary.running).toBe(true);
  expect(summary.current).toBe("shell call");
});

test("a step waiting for approval opens the log and failures are counted", () => {
  const summary = summarizeWork([
    call({ kind: "shell", command: "rm -rf dist" }, "awaiting_approval", 0),
    call({ kind: "shell", command: "false" }, "failed", 0, 10),
  ]);
  expect(summary.awaiting).toBe(true);
  expect(workCounts(summary)).toBe("Ran 2 commands · 1 failed");
});

test("an edit step reads with its target and the lines it added and removed", () => {
  const step = describeStep(
    call(
      {
        kind: "file.edit",
        changes: [{ path: "src/a.ts", kind: "update", oldText: "a\nb\n", newText: "a\nc\nd\n" }],
      },
      "succeeded",
      0,
      1,
    ),
  );
  expect(step).toMatchObject({ verb: "Edited", target: "src/a.ts", added: 3, removed: 2 });
  expect(step.settled).toBe(true);
});

test("a shell step notes its exit code, and a declined one says so instead", () => {
  const ran = describeStep(call({ kind: "shell", command: "ls", exitCode: 2 }, "succeeded", 0, 1));
  expect(ran).toMatchObject({ verb: "Ran", target: "ls", note: "exit 2" });
  const declined = describeStep(call({ kind: "shell", command: "ls" }, "declined", 0, 1));
  expect(declined.note).toBe("Declined");
});

test("the headline counts the elapsed time live while running and freezes when done", () => {
  const running = summarizeWork([call({ kind: "shell", command: "bun run build" }, "running", 0)]);
  expect(workLogHeadline(running, 12_000)).toMatchObject({
    label: "Working for 12s",
    current: "shell call",
  });
  const done = summarizeWork([
    call({ kind: "shell", command: "bun run build" }, "succeeded", 0, 4 * 60_000 + 12_000),
  ]);
  const headline = workLogHeadline(done, 99 * 60_000);
  expect(headline.label).toBe("Worked for 4m 12s");
  expect(headline.current).toBeUndefined();
});

test("an instant burst of work still reads as one second", () => {
  const done = summarizeWork([call({ kind: "file.read", path: "a" }, "succeeded", 5, 5)]);
  expect(workLogHeadline(done, 5).label).toBe("Worked for 1s");
});
