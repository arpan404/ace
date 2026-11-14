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
