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
  expect(summary.current).toBe("Running bun run build");
});

test("a step waiting for approval opens the log and failures are counted", () => {
  const summary = summarizeWork([
    call({ kind: "shell", command: "rm -rf dist" }, "awaiting_approval", 0),
    call({ kind: "shell", command: "false" }, "failed", 0, 10),
  ]);
  expect(summary.awaiting).toBe(true);
  expect(workCounts(summary)).toBe("Ran 2 commands · 1 failed");
});

test("an edit step reads with its target and the lines its patch added and removed", () => {
  const step = describeStep(
    call(
      {
        kind: "file.edit",
        changes: [{ path: "src/a.ts", kind: "update", diff: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n" }],
      },
      "succeeded",
      0,
      1,
    ),
  );
  expect(step).toMatchObject({ verb: "Edited", target: "src/a.ts", added: 2, removed: 1 });
  expect(step.settled).toBe(true);
});

test("a full-text edit leaves its stat to a text diff instead of counting on the spot", () => {
  const change = {
    path: "src/a.ts",
    kind: "update" as const,
    oldText: "a\nb\n",
    newText: "a\nc\nd\n",
  };
  const step = describeStep(call({ kind: "file.edit", changes: [change] }, "succeeded", 0, 1));
  expect(step).toMatchObject({ verb: "Edited", target: "src/a.ts", diffFor: [change] });
  expect(step.added).toBeUndefined();
});

test("a step's verb follows its status: running, awaiting approval, declined, done", () => {
  const push = { kind: "shell", command: "git push" } as const;
  expect(describeStep(call(push, "running", 0))).toMatchObject({ verb: "Running", settled: false });
  expect(describeStep(call(push, "pending", 0)).verb).toBe("Running");
  expect(describeStep(call(push, "awaiting_approval", 0))).toMatchObject({
    verb: "Run",
    note: "Awaiting approval",
  });
  expect(describeStep(call(push, "declined", 0, 1))).toMatchObject({
    verb: "Run",
    note: "Declined",
  });
  expect(describeStep(call({ ...push, exitCode: 0 }, "succeeded", 0, 1)).verb).toBe("Ran");
  expect(describeStep(call({ ...push, exitCode: 1 }, "failed", 0, 1)).verb).toBe("Ran");
  expect(describeStep(call({ kind: "file.read", path: "a.ts" }, "running", 0)).verb).toBe(
    "Reading",
  );
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
    current: "Running bun run build",
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

test("a wrapped command reads as the command inside it", () => {
  const step = describeStep(
    call({ kind: "shell", command: "/bin/zsh -lc 'bun install --frozen-lockfile'" }, "running", 0),
  );
  expect(step).toMatchObject({ verb: "Running", target: "bun install --frozen-lockfile" });
});

test("paths read relative to where the agent works, and skills by name", () => {
  const cwd = "/Users/ada/.ace-next/worktrees/3359/app";
  const read = describeStep(
    call({ kind: "file.read", path: `${cwd}/src/app.tsx` }, "succeeded", 0, 1),
    {
      cwd,
    },
  );
  expect(read).toMatchObject({ verb: "Read", target: "src/app.tsx", title: `${cwd}/src/app.tsx` });
  const skill = describeStep(
    call(
      { kind: "file.read", path: "/Users/ada/.agents/skills/diagnosing-bugs/SKILL.md" },
      "succeeded",
      0,
      1,
    ),
    { cwd },
  );
  expect(skill).toMatchObject({ verb: "Loaded skill", target: "diagnosing-bugs" });
});

test("a failed step says why: the exit code for commands, the error otherwise", () => {
  const shell = describeStep(
    call({ kind: "shell", command: "bun run test", exitCode: 1 }, "failed", 0, 1),
  );
  expect(shell).toMatchObject({ note: "exit 1", failed: true });
  const item = call(
    {
      kind: "mcp",
      server: "ace",
      tool: "ace_browser_open",
      arguments: { url: "https://youtube.com" },
    },
    "failed",
    0,
    1,
  );
  if (item.type === "tool_call") item.call.error = "Navigation blocked by the permission mode";
  expect(describeStep(item)).toMatchObject({
    verb: "Opened",
    target: "youtube.com",
    note: "Navigation blocked by the permission mode",
  });
});

test("a step behind an approval carries the approval's outcome on its row", () => {
  const item = call({ kind: "shell", command: "npm publish --dry-run" }, "awaiting_approval", 0);
  const request = {
    kind: "approval" as const,
    title: "Run npm publish",
    options: [
      { id: "once", label: "Allow once", kind: "allow_once" as const },
      { id: "deny", label: "Deny", kind: "deny" as const },
    ],
  };
  const waiting = describeStep(item, { interaction: { state: "pending", request } });
  expect(waiting).toMatchObject({ verb: "Run", note: "Waiting for your approval", needsYou: true });
  const approved = describeStep(item, {
    interaction: { state: "resolved", request, resolution: { kind: "approval", optionId: "once" } },
  });
  expect(approved).toMatchObject({ verb: "Running", note: "Approved by you", needsYou: false });
  const clicked = describeStep(item, {
    interaction: { state: "pending", request },
    answering: "deny",
  });
  expect(clicked).toMatchObject({ note: "Denied by you", failed: true });
});

test("a command that failed and then passed on a re-run counts as retried, not failed", () => {
  const summary = summarizeWork([
    call({ kind: "shell", command: "bun run test", exitCode: 1 }, "failed", 0, 1),
    call({ kind: "shell", command: "bun run lint", exitCode: 1 }, "failed", 1, 2),
    call({ kind: "shell", command: "bun run test", exitCode: 0 }, "succeeded", 2, 3),
  ]);
  expect(summary).toMatchObject({ failed: 1, retried: 1 });
  expect(workCounts(summary)).toBe("Ran 3 commands · 1 failed · 1 retried");
  expect(workLogHeadline(summary, 3).firstFailed).toBe(summary.firstFailed);
});
