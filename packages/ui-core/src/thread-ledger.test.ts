import { Interaction, Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { ThreadLedger, type LedgerReader } from "./thread-ledger.ts";

function step(id: string, at: number, status: "running" | "succeeded"): Item {
  return Item.parse({
    id,
    agentId: "root",
    createdAt: at,
    complete: status !== "running",
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: "shell",
      title: id,
      status,
      detail: { kind: "shell", command: id },
      startedAt: at,
      raw: [],
    },
  });
}

function approval(id: string, at: number, closedAt?: number): Interaction {
  return Interaction.parse({
    id,
    threadId: "thread-1",
    agentId: "root",
    blocking: true,
    request: { kind: "approval", title: id, options: [] },
    state: closedAt === undefined ? "pending" : "resolved",
    createdAt: at,
    ...(closedAt === undefined ? {} : { closedAt }),
  });
}

/** A long thread whose reads are counted, as a store hands them out. */
function longThread(items: number, interactions: number) {
  const byId = new Map<string, Item>();
  let order: string[] = [];
  for (let n = 0; n < items; n++) {
    const item = step(`s${n}`, n * 10, "succeeded");
    byId.set(item.id, item);
    order.push(item.id);
  }
  const asked = new Map<string, Interaction>();
  for (let n = 0; n < interactions; n++)
    asked.set(`a${n}`, approval(`a${n}`, n * 100, n * 100 + 40));
  const reads = { item: 0, interaction: 0 };
  const reader: LedgerReader = {
    get order() {
      return order;
    },
    item: (id) => {
      reads.item++;
      return byId.get(id);
    },
    run: () => undefined,
    agent: () => undefined,
    thread: undefined,
    interactionIds: () => [...asked.keys()],
    interaction: (id) => {
      reads.interaction++;
      return asked.get(id);
    },
    taskIds: () => [],
    task: () => undefined,
  };
  return {
    reader,
    reads,
    add(item: Item) {
      byId.set(item.id, item);
      order = [...order, item.id];
    },
    replace(item: Item) {
      byId.set(item.id, item);
    },
    ask(interaction: Interaction) {
      asked.set(interaction.id, interaction);
    },
  };
}

test("after the first read, a change costs reads of what changed, not of the whole thread", () => {
  const thread = longThread(5_000, 300);
  const ledger = new ThreadLedger().sync(thread.reader);
  thread.reads.item = 0;
  thread.reads.interaction = 0;

  // Nothing changed: nothing is read again.
  ledger.sync(thread.reader);
  expect(thread.reads).toEqual({ item: 0, interaction: 0 });

  // One new step and one new request: one read each, then the open ones re-checked.
  thread.add(step("new", 60_000, "running"));
  thread.ask(approval("asking", 60_001));
  ledger.sync(thread.reader);
  expect(thread.reads.item).toBeLessThanOrEqual(3);
  expect(thread.reads.interaction).toBeLessThanOrEqual(2);
  expect([...ledger.inFlight()]).toEqual(["new"]);
  expect([...ledger.pending()].map((interaction) => interaction.id)).toEqual(["asking"]);

  // The step settles and the request is answered: only those two are read again.
  thread.reads.item = 0;
  thread.reads.interaction = 0;
  thread.replace(step("new", 60_000, "succeeded"));
  thread.ask(approval("asking", 60_001, 60_101));
  ledger.sync(thread.reader);
  expect(thread.reads).toEqual({ item: 1, interaction: 1 });
  expect([...ledger.inFlight()]).toEqual([]);
  expect([...ledger.pending()]).toEqual([]);
});

test("waits on a person count once however they overlap, and only within the span asked", () => {
  const thread = longThread(0, 300);
  const ledger = new ThreadLedger().sync(thread.reader);
  // 300 waits of 40ms every 100ms; 1,050 to 2,070 holds the ten from 1,100 to 2,040.
  expect(ledger.waitedWithin(0, 30_000)).toBe(300 * 40);
  expect(ledger.waitedWithin(1_050, 2_070)).toBe(10 * 40);
  expect(ledger.waitedWithin(1_020, 1_120)).toBe(20 + 20);
  // A long wait from 1,000 to 5,000 swallows the 41 short ones it overlaps (through 5,040).
  thread.ask(approval("long", 1_000, 5_000));
  ledger.sync(thread.reader);
  expect(ledger.waitedWithin(0, 30_000)).toBe(300 * 40 - 41 * 40 + 4_040);
});
