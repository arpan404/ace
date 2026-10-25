import { afterEach, expect, test } from "vitest";
import { ScenarioPlayer, facts, interruptedTurn } from "@ace/fake-daemon";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * The phone's work log, grouped and worded as the web's, over the real SDK and an in-process
 * fake daemon. No provider CLI runs.
 */

afterEach(reset);

type Row = Record<string, unknown> & { kind: string; id: string; items?: string[] };
type Block = {
  kind: string;
  log?: Row[];
  ending?: Record<string, unknown>;
  files?: Record<string, unknown>;
};
const blocks = () => rows("thread.block") as Block[];
const log = () => blocks().find((row) => row.kind === "work")?.log;

test("a running group is titled by its step in flight with its count, and its thought keeps its row", async () => {
  const fake = fixture();
  fake.createThread({ id: "parallel", workspaceId: "ace", title: "Parallel", provider: "claude" });
  fake.apply("parallel", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check both builds"),
    {
      type: "item.upsert",
      agent: "root",
      item: "thought",
      draft: { type: "reasoning", complete: true, text: "The slow build can run alongside." },
    },
    facts.tool("root", "slow", {
      kind: "shell",
      title: "slow",
      detail: { kind: "shell", command: "bun run slow" },
    }),
    facts.tool("root", "quick", {
      kind: "shell",
      title: "quick",
      detail: { kind: "shell", command: "bun run quick" },
    }),
    facts.toolDone("root", "quick"),
  ]);
  open(connect(fake), "parallel");
  const rowsNow = await until(() => (log()?.length === 2 ? log() : undefined), "the live log");
  const [thought, group] = rowsNow;
  expect(thought).toMatchObject({ kind: "thought", done: true });
  expect(String(thought?.label)).toMatch(/^Thought/);
  // The unfinished parallel step titles the group, not the later one that finished.
  const slow = group?.items?.[0];
  expect(group).toMatchObject({ kind: "group", running: true, active: slow, count: "2 steps" });

  fake.apply("parallel", [facts.toolDone("root", "slow")]);
  const settled = await until(
    () => log()?.find((row) => row.kind === "group" && row.running === false),
    "the group to settle",
  );
  expect(settled.sentence).toBe("Ran 2 commands");
});

test("background commands started back to back are one group, ended ones only inside it", async () => {
  const fake = fixture();
  const player = new ScenarioPlayer(fake, interruptedTurn("bg"), { agoMs: 0 });
  player.runThrough("background");
  open(connect(fake), "bg");
  const group = await until(
    () => log()?.find((row) => row.kind === "background" && row.label),
    "the background group",
  );
  expect(group.label).toBe("3 background tasks · 1 running");
  expect(group.runningIds).toHaveLength(1);
  expect(group.listed).toHaveLength(2);

  player.runThrough("background-done");
  const done = await until(
    () => log()?.find((row) => row.kind === "background" && row.label === "Ran 3 background tasks"),
    "the group to end",
  );
  expect(done.runningIds).toEqual([]);
  expect(done.listed).toHaveLength(3);
});

test("a failed turn reads as one row, the model before the reason, the provider's words behind Details", async () => {
  const fake = fixture();
  fake.createThread({
    id: "failing",
    workspaceId: "ace",
    title: "Greeting",
    provider: "cursor",
    execution: { provider: "cursor", model: "composer-2.5", options: {} },
  });
  fake.apply("failing", [
    facts.rootAgent("cursor"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "yo"),
    {
      type: "item.upsert",
      agent: "root",
      item: "run-failed",
      draft: {
        type: "notice",
        level: "error",
        diagnostic: true,
        code: "cursor.run-failed",
        text: "Increase limits for faster responses",
        complete: true,
      },
    },
    facts.endTurn("root", "failed"),
  ]);
  open(connect(fake), "failing");
  const ending = await until(() => blocks().find((row) => row.kind === "end")?.ending, "the end");
  expect(ending).toMatchObject({
    kind: "failed",
    label: "Turn failed",
    message: "Composer 2.5 · Cursor couldn't finish the request. Try again.",
    details: "Increase limits for faster responses",
  });
});

test("the person's Stop reads Interrupted by you, and the turn's edits read as file chips", async () => {
  const fake = fixture();
  fake.createThread({ id: "stopped", workspaceId: "ace", title: "Stop", provider: "codex" });
  fake.apply("stopped", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Tidy the config"),
    facts.tool("root", "edit", {
      kind: "file.edit",
      title: "edit",
      detail: {
        kind: "file.edit",
        changes: [
          { path: "src/relay/config.ts", kind: "update", diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" },
        ],
      },
    }),
    facts.toolDone("root", "edit"),
    facts.endTurn("root", "interrupted"),
  ]);
  open(connect(fake), "stopped");
  const ending = await until(() => blocks().find((row) => row.kind === "end")?.ending, "the end");
  expect(ending).toMatchObject({ kind: "interrupted", label: "Interrupted by you" });
  const files = await until(() => blocks().find((row) => row.kind === "files")?.files, "the files");
  expect(files).toEqual({
    label: "Changed 1 file",
    more: 0,
    chips: [{ path: "src/relay/config.ts", name: "config.ts", added: 2, removed: 1 }],
  });
});

const reasoning = (item: string, complete: boolean) => ({
  type: "item.upsert" as const,
  agent: "root",
  item,
  draft: { type: "reasoning" as const, complete, text: "" },
});
const shell = (item: string, command: string) =>
  facts.tool("root", item, { kind: "shell", title: command, detail: { kind: "shell", command } });

test("a thought with no words between calls never regroups the log: it titles the running group", async () => {
  const fake = fixture();
  fake.createThread({ id: "think", workspaceId: "ace", title: "Think", provider: "codex" });
  fake.apply("think", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Build it"),
    shell("lint", "bun run lint"),
    facts.toolDone("root", "lint"),
    reasoning("first", false),
  ]);
  open(connect(fake), "think");
  // One call and a thought in flight: still the call's own row, not a group of two.
  const lone = await until(() => (log()?.length === 1 ? log() : undefined), "the lone step");
  expect(lone[0]?.kind).toBe("step");
  const first = lone[0]?.id;

  fake.apply("think", [
    reasoning("first", true),
    shell("build", "bun run build"),
    facts.toolDone("root", "build"),
    reasoning("second", false),
  ]);
  const titled = await until(
    () => log()?.find((row) => row.kind === "group" && row.running === true),
    "the group titled by the thought",
  );
  // The step's row became a group once, under the same id; the thought titles it, uncounted.
  expect(titled).toMatchObject({ id: first, count: "2 steps" });
  expect(titled.items).toHaveLength(2);
  expect(titled.items).not.toContain(titled.active);

  fake.apply("think", [reasoning("second", true), shell("test", "bun run test")]);
  const grown = await until(
    () => log()?.find((row) => row.kind === "group" && row.items?.length === 3),
    "the next call to join",
  );
  expect(grown).toMatchObject({ id: first, active: grown.items?.[2] });
  expect(log()).toHaveLength(1);
});
