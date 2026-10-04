import { setImmediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ItemId, ThreadId } from "@ace/protocol";
import { multiDayThread } from "@ace/fake-daemon";
import {
  storeFixture,
  start,
  end,
  tool,
  agentMessage,
  turns,
  catchUp,
} from "./long-thread-test-support.ts";

// Mutations: approximate time with seq, ignore parent timestamp regressions, or include
// pre-cutoff file changes in the generated turn. Not executed (tests run at merge).
test("midturn fixture catch-up retains later work when its subagent proxy arrives at turn-start time", () => {
  const f = storeFixture();
  const at = 1_791_000_000_000;
  const id = ThreadId.parse("midturn-fixture");
  for (const record of multiDayThread({
    threadId: id,
    workspaceId: f.workspace,
    items: 200,
    turns: 2,
    subagents: 1,
    startedAt: at,
    durationMs: 2048,
  }))
    f.store.appendEvents(record.threadId, [record.payload], record.at);
  const summary = f.store.threadCatchUp({ threadId: id, sinceTime: at + 500 });
  expect(summary.turnsCompleted).toBe(2);
  expect(summary.digest.commandsRun).toBe(2);
  expect(summary.digest.commands.map((command) => command.command)).toEqual([
    "git diff --check checkpoint-2",
    "git diff --check checkpoint-1",
  ]);
  expect(summary.digest.files).toEqual([
    { path: "src/module-1.ts", added: 2, removed: 1 },
    { path: "src/module-2.ts", added: 4, removed: 2 },
  ]);
  expect(summary.digest).toMatchObject({
    inputTokens: 2000,
    outputTokens: 800,
    subagentsStarted: 0,
    subagentsFinished: 1,
  });
});

// Mutations: report ready before bounded migration finishes, double-count replayed
// counters, drop writes during upgrade, restore deleted preview caches, or lose resume state.
// Not executed (tests run at merge).
test("an old digest database resumes timestamp migration while retaining canonical live writes", async () => {
  const f = storeFixture();
  start(f.store, f.thread, "upgrade", 10);
  for (let i = 0; i < 300; i++)
    f.store.appendEvents(
      f.thread.id,
      [
        {
          type: "item.created",
          item: tool(
            `upgrade-${i}`,
            "succeeded",
            { kind: "shell", command: `old ${i}`, exitCode: 0 },
            "upgrade",
          ),
        },
      ],
      i % 2 ? 100 : 200,
    );
  const empty = tool(
    "historical-empty",
    "succeeded",
    { kind: "file.write", changes: [{ path: "historical-empty.ts", kind: "add", newText: "" }] },
    "upgrade",
  );
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: empty }], 200);
  f.store.appendEvents(f.thread.id, [{ type: "item.deleted", itemId: empty.id }], 100);
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.created", item: agentMessage("removed-preview", "Deleted cache", "upgrade") },
      { type: "item.deleted", itemId: ItemId.parse("removed-preview") },
    ],
    201,
  );
  end(f.store, f.thread, "upgrade", 210);
  await f.store.close();
  const legacy = new DatabaseSync(join(f.home, "events.sqlite"));
  try {
    for (const table of [
      "long_range_nodes",
      "long_time_files",
      "long_time_commands",
      "long_time_command_nodes",
      "long_completions",
      "long_range_migration",
      "long_range_file_members",
    ])
      legacy.exec(`DROP TABLE ${table}`);
    legacy.exec("UPDATE long_turns SET latest='Deleted cache'");
  } finally {
    legacy.close();
  }
  await f.restart();
  expect(catchUp(f.store, f.thread, { sinceTime: 150 }).ready).toBe(false);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "during-upgrade",
          "succeeded",
          { kind: "shell", command: "live work", exitCode: 0 },
          "upgrade",
        ),
      },
    ],
    220,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "during-upgrade-file",
          "succeeded",
          {
            kind: "file.write",
            changes: [{ path: "live.ts", kind: "add", newText: "one\ntwo\nthree\n" }],
          },
          "upgrade",
        ),
      },
    ],
    220,
  );
  await f.restart();
  while (!turns(f.store, f.thread).ready) await setImmediate();
  const summary = catchUp(f.store, f.thread, { sinceTime: 150 });
  expect(summary.ready).toBe(true);
  expect(summary.digest.commandsRun).toBe(151);
  expect(summary.digest.files).toEqual([
    { path: "historical-empty.ts", added: 0, removed: 0 },
    { path: "live.ts", added: 3, removed: 0 },
  ]);
  expect(summary.turnsCompleted).toBe(1);
  expect(turns(f.store, f.thread).turns[0]?.latestAgentMessagePreview).toBe("");
  const indexedSeq = summary.indexedSeq;
  await f.restart();
  expect(catchUp(f.store, f.thread, { sinceTime: 150 })).toMatchObject({
    indexedSeq,
    ready: true,
    turnsCompleted: 1,
    digest: { commandsRun: 151 },
  });
});
