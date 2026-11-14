import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * While the agent compacts its context the transcript says so where the turn's live line stands
 * ("Compacting context", the shared turn activity), and once the compaction lands the line goes
 * and the finished "Context compacted" row stays. Over the real SDK and the fake daemon; no
 * provider CLI runs.
 */

afterEach(reset);

type LiveBlock = { kind: string; live: { label: string; since: number | null } | null };
const liveBlock = () =>
  rows("thread.block").find((row) => row.kind === "live") as LiveBlock | undefined;
const compacted = () =>
  rows("thread.block").find(
    (row) => (row.event as { icon?: string } | null | undefined)?.icon === "compaction",
  ) as { event: { text: string } } | undefined;

test("a compaction reads as a live Compacting context line, then as the finished row", async () => {
  const fake = fixture();
  fake.createThread({ id: "squeeze", workspaceId: "ace", title: "Squeeze", provider: "claude" });
  fake.apply("squeeze", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Keep going."),
    { type: "activity", agent: "root", activity: "compacting" },
  ]);
  open(connect(fake), "squeeze");
  const live = await until(() => liveBlock()?.live ?? undefined, "the live compacting line");
  expect(live.label).toBe("Compacting context");
  expect(compacted()).toBeUndefined();

  fake.apply("squeeze", [
    {
      type: "item.upsert",
      agent: "root",
      item: "compact",
      draft: { type: "compaction", complete: true },
    },
  ]);
  const row = await until(compacted, "the compaction row");
  expect(row.event.text).toBe("Context compacted");
  await until(() => !liveBlock()?.live, "the live line to go");
});

test("the compacting line counts from when compaction began, not from the work before it", async () => {
  const minute = 60_000;
  let now = Date.now() - 10 * minute;
  const fake = fixture(() => now);
  fake.createThread({ id: "long", workspaceId: "ace", title: "Long", provider: "claude" });
  fake.apply("long", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Keep going."),
    facts.tool("root", "read", {
      kind: "shell",
      title: "Read the plan",
      detail: { kind: "shell", command: "cat plan.md" },
    }),
  ]);
  const workStarted = now;
  now += 5 * minute;
  const compactionStarted = now;
  fake.apply("long", [
    facts.toolDone("root", "read"),
    { type: "activity", agent: "root", activity: "compacting" },
  ]);
  open(connect(fake), "long");
  const live = await until(() => liveBlock()?.live ?? undefined, "the live compacting line");
  expect(live.since).toBe(compactionStarted);
  expect(live.since).not.toBe(workStarted);
});
