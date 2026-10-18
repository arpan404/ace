import type { ThreadSource } from "@ace/client";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { inRootLane } from "@ace/projection";
import type { Item } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { Jump } from "./jump.ts";

/*
 * A long Claude thread whose turn runs two busy subagents: the live tail (200 items) holds the
 * root's newest hundred items and the subagents' newest hundred, so the root transcript the
 * reader scrolls through reaches back much further than the tail's cursor.
 */

type Fact = Parameters<FakeDaemon["apply"]>[1][number];
const threadId = "busy";
/** Every item's label, in the order the daemon created them, and whether the root shows it. */
let created: { label: string; root: boolean }[] = [];
let releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  created = [];
});

const say = (agent: string, role: "user" | "assistant", text: string): Fact => {
  created.push({ label: text, root: agent === "root" });
  return facts.message(agent, `item-${created.length}`, role, text);
};
const spawn = (child: string): Fact => {
  created.push({ label: `Start ${child}`, root: true });
  return facts.tool("root", `spawn-${child}`, {
    kind: "agent.spawn",
    title: `Start ${child}`,
    detail: { kind: "agent.spawn", description: `Start ${child}`, childAgent: child },
  });
};
const label = (item: Item | undefined) =>
  item?.type === "message"
    ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    : item?.type === "tool_call"
      ? item.call.title
      : undefined;
/** Subagent output with a root note every so often, as a busy turn writes it. */
function busy(from: number, count: number): Fact[] {
  const out: Fact[] = [];
  for (let n = from; n < from + count; n++) {
    out.push(say(n % 2 ? "sub-a" : "sub-b", "assistant", `Sub step ${n}`));
    if (n % 25 === 24) out.push(say("root", "assistant", `Root note ${n}`));
  }
  return out;
}

async function busyThread() {
  const daemon = new FakeDaemon({ clock: () => 1, snapshotItems: 200 });
  daemon.createThread({ id: threadId, workspaceId: "ace", title: "Busy", provider: "claude" });
  daemon.apply(threadId, [facts.rootAgent("claude")]);
  for (let turn = 0; turn < 80; turn++)
    daemon.apply(threadId, [
      say("root", "user", `Prompt ${turn}`),
      facts.turn("root"),
      say("root", "assistant", `Reply ${turn}`),
      facts.endTurn("root"),
    ]);
  daemon.apply(threadId, [
    say("root", "user", "Busy prompt"),
    facts.turn("root"),
    spawn("sub-a"),
    facts.subagent("claude", "sub-a", "Explorer", "spawn-sub-a"),
    facts.turn("sub-a", "spawn"),
    spawn("sub-b"),
    facts.subagent("claude", "sub-b", "Reviewer", "spawn-sub-b"),
    facts.turn("sub-b", "spawn"),
    ...busy(0, 260),
  ]);
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread(threadId);
  releases.push(() => lease.release());
  const live = lease.store;
  await vi.waitFor(() => expect(label(live.item(live.order.at(-1) ?? ""))).toBe("Sub step 259"));
  const jump = new Jump(client, threadId);
  releases.push(() => jump.dispose());
  const rootLane = (id: string) => inRootLane(live.item(id)?.agentId, live.thread?.rootAgentId);
  jump.setTail(() => ({
    order: live.order,
    before: live.itemsBefore,
    firstItemOf: () => undefined,
    seq: (id) => live.itemSeq(id),
    item: (id) => live.item(id),
    inLane: rootLane,
  }));
  return { daemon, live, jump };
}

/** The source the transcript reads: the window joined to the tail, or the tail alone. */
function shown(jump: Jump, live: ThreadSource): ThreadSource {
  const { window, joined } = jump.snapshot();
  return (window && jump.source(live, window, joined)) ?? live;
}
/** The root transcript's rows, top to bottom. */
function rows(source: ThreadSource): string[] {
  const root = source.thread?.rootAgentId;
  return source.order.flatMap((id) => {
    const item = source.item(id);
    const text = label(item);
    return text !== undefined && inRootLane(item?.agentId, root) ? [text] : [];
  });
}
/** The root lane as the daemon created it, from `first` on. */
function createdRootFrom(first: string | undefined): string[] {
  const at = created.findIndex((entry) => entry.label === first);
  return created.slice(Math.max(0, at)).flatMap((entry) => (entry.root ? [entry.label] : []));
}
/** Labels in creation order, by their place in the daemon's history. */
const createdIndex = (text: string) => created.findIndex((entry) => entry.label === text);

async function deliver(daemon: FakeDaemon, live: ThreadSource, jump: Jump, more: Fact[]) {
  const last = more.findLast((fact) => fact.type === "item.upsert");
  daemon.apply(threadId, more);
  const lastLabel = created.at(-1)?.label;
  if (last)
    await vi.waitFor(() => expect(label(live.item(live.order.at(-1) ?? ""))).toBe(lastLabel));
  jump.tailMoved();
}

test("scrolling to older history never drops or reorders rows the reader already sees", async () => {
  const { daemon, live, jump } = await busyThread();
  // The reader has scrolled up through the root transcript the tail shows: its root items
  // reach far back past where the tail holds the subagents' items from.
  const seen = rows(live);
  expect(seen).toContain("Busy prompt");
  expect(seen.length).toBeGreaterThan(60);

  await jump.older();
  const first = rows(shown(jump, live));
  // Everything the reader saw is still there, below the older turns read in above it, and
  // the root transcript is the daemon's own, complete and in creation order.
  expect(first.slice(-seen.length)).toEqual(seen);
  expect(first.length).toBeGreaterThan(seen.length);
  expect(first).toEqual(createdRootFrom(first[0]));
  // Older history arrives in whole turns: the window starts with the turn's prompt.
  expect(first[0]).toMatch(/^Prompt \d+$/);

  // The subagents keep working while the reader reads: the tail trims its oldest items.
  await deliver(daemon, live, jump, busy(260, 240));
  const during = rows(shown(jump, live));
  expect(during.slice(0, first.length)).toEqual(first);
  expect(during).toEqual(createdRootFrom(during[0]));

  await jump.older();
  const deeper = rows(shown(jump, live));
  expect(deeper.slice(-during.length)).toEqual(during);
  expect(deeper).toEqual(createdRootFrom(deeper[0]));
  // Status never depends on the window: the busy turn is still working.
  expect(shown(jump, live).thread?.status.state).toBe(live.thread?.status.state);
  expect(live.thread?.status.state).not.toBe("done");
});

test("a joined older window merges with the live tail in creation order", async () => {
  const { daemon, live, jump } = await busyThread();
  await jump.older();
  expect(jump.snapshot().joined).toBe(true);
  // A new prompt and the agent output that answers it arrive live, among subagent output.
  await deliver(daemon, live, jump, [
    ...busy(260, 30),
    facts.endTurn("root"),
    say("root", "user", "Next prompt"),
    facts.turn("root"),
    ...busy(290, 40),
    say("root", "assistant", "Next reply"),
    ...busy(330, 150),
  ]);
  const source = shown(jump, live);
  const order = source.order.map((id) => label(source.item(id)) ?? "");
  // Every item (both lanes) sits where the daemon created it; the root lane is whole.
  const places = order.map(createdIndex);
  expect(places.every((place, index) => index === 0 || place > (places[index - 1] ?? 0))).toBe(
    true,
  );
  const root = rows(source);
  expect(root).toEqual(createdRootFrom(root[0]));
  expect(root.indexOf("Busy prompt")).toBeLessThan(root.indexOf("Start sub-a"));
  expect(root.indexOf("Next prompt")).toBeGreaterThan(root.indexOf("Root note 274"));
  expect(root.indexOf("Next prompt")).toBeLessThan(root.indexOf("Next reply"));
  expect(root.at(-1)).toBe("Root note 474");
});
