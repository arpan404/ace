import { expect, test } from "vitest";
import {
  start,
  end,
  turns,
  catchUp,
  storeFixture,
  tool,
  root,
} from "./long-thread-test-support.ts";

// Mutations: approximate a wall-time cutoff with a sequence, assume increasing timestamps,
// include events exactly at the cutoff, or lose existing range data after restart.
// Not executed (tests run at merge).
test("catch-up selects literal event times despite later appends having earlier timestamps", async () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "late-command",
          "failed",
          { kind: "shell", command: "late work", exitCode: 7 },
          "first",
        ),
      },
      {
        type: "item.created",
        item: tool(
          "late-file",
          "succeeded",
          {
            kind: "file.write",
            changes: [{ path: "late.ts", kind: "add", newText: "one\ntwo\n" }],
          },
          "first",
        ),
      },
      {
        type: "usage.updated",
        agentId: root,
        usageScope: "agent",
        counterMode: "incremental",
        inputTokens: 100,
        outputTokens: 10,
      },
    ],
    200,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "earlier-command",
          "succeeded",
          { kind: "shell", command: "earlier work", exitCode: 0 },
          "first",
        ),
      },
      {
        type: "item.created",
        item: tool(
          "earlier-file",
          "succeeded",
          { kind: "file.write", changes: [{ path: "earlier.ts", kind: "add", newText: "old\n" }] },
          "first",
        ),
      },
      {
        type: "usage.updated",
        agentId: root,
        usageScope: "agent",
        counterMode: "incremental",
        inputTokens: 20,
        outputTokens: 2,
      },
    ],
    100,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "boundary-command",
          "succeeded",
          { kind: "shell", command: "boundary work", exitCode: 0 },
          "first",
        ),
      },
    ],
    150,
  );
  end(f.store, f.thread, "first", 210);
  start(f.store, f.thread, "second", 50);
  end(f.store, f.thread, "second", 120);
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    const summary = catchUp(f.store, f.thread, { sinceTime: 150 });
    expect(summary.ready).toBe(true);
    expect(summary.turnsCompleted).toBe(1);
    expect(summary.digest).toMatchObject({
      commandsRun: 1,
      commandsFailed: 1,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(summary.digest.commands.map((value) => value.command)).toEqual(["late work"]);
    expect(summary.digest.files).toEqual([{ path: "late.ts", added: 2, removed: 0 }]);
  }
});

// Mutations: use net completion changes after the cutoff, allowing a reopened older turn
// to cancel a different completed turn; keep a reopened completion in the maintained index.
// Not executed (tests run at merge).
test("reopening an older completed turn cannot cancel a newer completed turn in catch-up", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  end(f.store, f.thread, "first", 30);
  const boundary = f.store.headSeq();
  start(f.store, f.thread, "second", 40);
  end(f.store, f.thread, "second", 50);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("late-running", "running", { kind: "shell", command: "still working" }, "first"),
      },
    ],
    60,
  );
  expect(turns(f.store, f.thread).turns[0]?.endedAt).toBeUndefined();
  expect(catchUp(f.store, f.thread, { sinceSeq: boundary }).turnsCompleted).toBe(1);
  expect(catchUp(f.store, f.thread, { sinceTime: 35 }).turnsCompleted).toBe(1);
});

// Mutations: truncate epoch milliseconds to 32 bits, double count radix boundaries,
// choose command state by timestamp instead of canonical seq, or let noncommands fill the cap.
// Not executed (tests run at merge).
test("epoch-time catch-up selects the latest eligible command revision without unrelated item truncation", () => {
  const f = storeFixture();
  const at = 1_791_000_000_000;
  start(f.store, f.thread, "epoch", at - 1);
  for (let i = 0; i < 80; i++)
    f.store.appendEvents(
      f.thread.id,
      [
        {
          type: "item.created",
          item: tool(`read-${i}`, "succeeded", { kind: "file.read", path: "read.ts" }, "epoch"),
        },
      ],
      at + 100,
    );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("epoch-command", "running", { kind: "shell", command: "build" }, "epoch"),
      },
    ],
    at + 512,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.updated",
        item: tool(
          "epoch-command",
          "failed",
          { kind: "shell", command: "build", exitCode: 2 },
          "epoch",
        ),
      },
    ],
    at + 256,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("at-boundary", "succeeded", { kind: "shell", command: "excluded" }, "epoch"),
      },
    ],
    at,
  );
  const summary = catchUp(f.store, f.thread, { sinceTime: at });
  expect(summary.digest.commands).toEqual([
    { itemId: "epoch-command", command: "build", failed: true, exitCode: 2 },
  ]);
  expect(summary.digest.commandsRun).toBe(1);
  expect(summary.digest.commandsFailed).toBe(1);
  expect(summary.digest.truncated).toBe(false);
});
