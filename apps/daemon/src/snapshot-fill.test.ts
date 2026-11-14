import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  Agent,
  AgentItem,
  type EventPayload,
  type ServerMessage,
  type ThreadId,
  type ThreadView,
} from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";

/*
 * A thread opened from a small tail, then filled, must hold exactly what a full snapshot holds:
 * the same items in the same order with the same bodies, the same cursor and the same agents.
 * The fill's answer is the contract a client merges by: the full snapshot's item and agent ids,
 * and the bodies of whatever the small snapshot did not carry whole.
 */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

const screen = { items: 30, bytes: 48 * 1024 };

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-snapshot-fill-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  return { store, threadId: thread.id };
}
const agent = (threadId: ThreadId, id: string, parentId: string | null) =>
  Agent.parse({
    id,
    threadId,
    parentId,
    origin: parentId ? "provider_subagent" : "root",
    fidelity: "full",
    native: { provider: "codex" },
    cwd: "/repo",
    status: { state: "idle" },
    createdAt: 1,
    background: false,
  });
const reply = (id: string, agentId: string, text: string) =>
  AgentItem.parse({
    id,
    agentId,
    type: "message",
    role: "assistant",
    complete: true,
    createdAt: 1,
    parts: [{ type: "text", text }],
  });

let ids = 0;
function opened(store: Store, threadId: ThreadId, tail?: typeof screen): ThreadView {
  const sent: ServerMessage[] = [];
  const stop = subscribe(
    store,
    `s${++ids}`,
    { kind: "thread", threadId },
    undefined,
    5000,
    (m) => sent.push(m),
    250,
    undefined,
    false,
    undefined,
    undefined,
    tail,
  );
  stop();
  const snapshot = sent[0];
  if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "thread") throw new Error("No view");
  return snapshot.view;
}

const own = <T>(record: Record<string, T>, id: string) =>
  Object.hasOwn(record, id) ? record[id] : undefined;
/** The text of the item `long` as `view` holds it. */
const text = (view: ThreadView) => {
  const item = view.items.long;
  return item?.type === "message" && item.parts[0]?.type === "text" ? item.parts[0].text : "";
};

/** The small snapshot with its fill merged in, as the client merges it. */
function filled(store: Store, small: ThreadView): ThreadView {
  const fill = small.fill;
  if (!fill) return small;
  const answer = store.readSnapshotFill(small.thread.id, fill);
  const items = Object.fromEntries(
    answer.order.map((id) => {
      const item = answer.items.find((candidate) => candidate.id === id) ?? own(small.items, id);
      if (!item) throw new Error(`Fill left ${id} without a body`);
      return [id, item];
    }),
  );
  const agents = Object.fromEntries(
    answer.agentIds.map((id) => {
      const body = own(answer.agents, id) ?? own(small.agents, id);
      if (!body) throw new Error(`Fill left agent ${id} without a body`);
      return [id, body];
    }),
  );
  return {
    ...small,
    items,
    itemOrder: answer.order,
    itemSeqs: Object.fromEntries(
      answer.order.map((id) => [
        id,
        own(answer.itemSeqs, id) ?? own(small.itemSeqs ?? {}, id) ?? 0,
      ]),
    ),
    itemsBefore: answer.itemsBefore,
    agents,
  };
}
const transcript = (view: ThreadView) => ({
  order: view.itemOrder,
  items: view.itemOrder.map((id) => view.items[id]),
  seqs: view.itemOrder.map((id) => view.itemSeqs?.[id]),
  before: view.itemsBefore,
  agents: Object.keys(view.agents)
    .toSorted()
    .map((id) => view.agents[id]),
});

it("an older child referenced only by an item outside the tail comes with the fill", () => {
  const { store, threadId } = setup();
  store.appendEvents(threadId, [{ type: "agent.created", agent: agent(threadId, "root", null) }]);
  store.appendEvents(threadId, [
    { type: "agent.created", agent: agent(threadId, "early", "root") },
  ]);
  store.appendEvents(threadId, [{ type: "item.created", item: reply("early-1", "early", "x") }]);
  // Over 200 settled agents since: the status window no longer holds the early child.
  for (let index = 0; index < 260; index += 20)
    store.appendEvents(
      threadId,
      Array.from({ length: 20 }, (_, n) => ({
        type: "agent.created" as const,
        agent: agent(threadId, `late${index + n}`, "root"),
      })),
    );
  for (let index = 0; index < 60; index++)
    store.appendEvents(threadId, [
      { type: "item.created", item: reply(`r${index}`, "root", `reply ${index}`) },
    ]);
  const full = opened(store, threadId);
  const small = opened(store, threadId, screen);
  expect(Object.hasOwn(full.agents, "early")).toBe(true);
  expect(Object.hasOwn(small.agents, "early")).toBe(false);
  expect(transcript(filled(store, small))).toEqual(transcript(full));
});

it("a newest reply too large for the tail arrives whole with the fill", () => {
  const { store, threadId } = setup();
  store.appendEvents(threadId, [{ type: "agent.created", agent: agent(threadId, "root", null) }]);
  for (let index = 0; index < 10; index++)
    store.appendEvents(threadId, [
      { type: "item.created", item: reply(`r${index}`, "root", `reply ${index}`) },
    ]);
  const long = "a long answer line\n".repeat(3300);
  store.appendEvents(threadId, [{ type: "item.created", item: reply("long", "root", long) }]);
  const full = opened(store, threadId);
  const small = opened(store, threadId, screen);
  expect(text(full)).toBe(long);
  expect(text(small).length).toBeLessThan(long.length);
  expect(text(filled(store, small))).toBe(long);
  expect(transcript(filled(store, small))).toEqual(transcript(full));
});

/** A small deterministic generator: the same seed builds the same thread. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generated thread: lanes, sizes from a line to past the tail, deletes, re-creates, agents. */
function generated(seed: number) {
  const next = random(seed);
  const { store, threadId } = setup();
  store.appendEvents(threadId, [{ type: "agent.created", agent: agent(threadId, "root", null) }]);
  const events: EventPayload[] = [];
  const children: string[] = [];
  const live: string[] = [];
  const steps = 40 + Math.floor(next() * 320);
  for (let step = 0; step < steps; step++) {
    const roll = next();
    if (roll < 0.12 || (roll < 0.3 && children.length < 3)) {
      const parent =
        children.length && next() < 0.3 ? children[Math.floor(next() * children.length)] : "root";
      const id = `agent${children.length}`;
      children.push(id);
      events.push({ type: "agent.created", agent: agent(threadId, id, parent ?? "root") });
      continue;
    }
    if (roll < 0.17 && live.length) {
      const [id] = live.splice(Math.floor(next() * live.length), 1);
      if (id) events.push({ type: "item.deleted", itemId: reply(id, "root", "").id });
      continue;
    }
    const sizeRoll = next();
    const size =
      sizeRoll < 0.04
        ? 52_000 + Math.floor(next() * 20_000)
        : sizeRoll < 0.2
          ? 5_000
          : 200 + Math.floor(next() * 2_500);
    const lane =
      next() < 0.5 || !children.length
        ? "root"
        : (children[Math.floor(next() * children.length)] ?? "root");
    if (roll < 0.22 && live.length) {
      // A repeated create: the same id upserted with new content.
      const id = live[Math.floor(next() * live.length)] ?? "";
      events.push({ type: "item.created", item: reply(id, lane, "again ".repeat(size / 6)) });
      continue;
    }
    const id = `item${step}`;
    live.push(id);
    events.push({
      type: "item.created",
      item: reply(id, lane, `${id} `.repeat(size / (id.length + 1))),
    });
  }
  // Appended in batches, as a busy provider's events are: the same events, fewer commits.
  for (let index = 0; index < events.length; index += 40)
    store.appendEvents(threadId, events.slice(index, index + 40));
  return { store, threadId };
}

it("over generated threads a small tail plus its fill is exactly the full snapshot", () => {
  const reached = { older: 0, whole: 0, shrunk: 0 };
  for (let seed = 1; seed <= 24; seed++) {
    const { store, threadId } = generated(seed);
    const full = opened(store, threadId);
    const small = opened(store, threadId, screen);
    if (small.fill?.before != null) reached.older++;
    if (small.fill?.whole?.length) reached.whole++;
    if (full.itemOrder.length < 200 && full.itemsBefore !== null) reached.shrunk++;
    expect(transcript(filled(store, small)), `seed ${seed}`).toEqual(transcript(full));
  }
  // The generator reaches the hard cases: older items to fill, previews, and a full snapshot
  // cut short of 200 items by its byte budget.
  expect(reached.older).toBeGreaterThan(10);
  expect(reached.whole).toBeGreaterThan(0);
  expect(reached.shrunk).toBeGreaterThan(0);
});
