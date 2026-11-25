// SPDX-License-Identifier: Apache-2.0
/**
 * The TypeScript engine writes the home `commands-home.process.test.ts` reads (E5.4a): a queue
 * with three waiting sends (one a steer that fell back), an uncertain one, a child result and a
 * `stopped` hold; three settled intents; a thread whose uncertain sends were submitted in two
 * generations; and E5.4c's input-fate thread, one row per fate rule. No provider CLI and no
 * daemon: the TypeScript store modules write the rows, and the parent's native engine reads them.
 */
import { join } from "node:path";
import { AgentId, Command, CommandId, Item, NativeSessionId, ThreadId } from "@ace/protocol";
import { createThreadState } from "@ace/core";
import { Store } from "../../store.ts";
import { createDevThread } from "../../commands.ts";
import { IntentStore } from "../../engine/intents.ts";
import { QueueStore } from "../../engine/queue-store.ts";
import { InputJournal } from "../../engine/input-journal.ts";
import { SteerNotes } from "../../engine/steer-notes.ts";
import { migrateEngine } from "../../engine/migrations.ts";

const home = process.env.ACE_HOME;
if (!home) throw new Error("ACE_HOME is required");

const store = new Store(join(home, "events.sqlite"));
store.atomic((db) => migrateEngine(db));
const workspace = store.createWorkspace(home, "Home");
const queue = new QueueStore(store);
const intents = new IntentStore(store, queue);
const notes = new SteerNotes(store);
const at = 1_000;

function add(
  thread: ThreadId,
  id: string,
  text: string,
  extra: Partial<{ delivery: "queue" | "steer"; trigger: string }> = {},
): number {
  const command = Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: thread,
      input: [{ type: "text", text }],
      ...(extra.delivery ? { delivery: extra.delivery } : {}),
      ...(extra.trigger ? { trigger: extra.trigger } : {}),
    },
  });
  intents.add(command, thread);
  for (const header of intents.headers(thread)) if (header.commandId === id) return header.id;
  throw new Error(`no intent ${id}`);
}

// The queue's thread: rows the native engine reads through its own statements.
const thread = createDevThread(store, workspace).id;
queue.ensure(thread);
add(thread, "queued-a", "first");
add(thread, "queued-b", "second");
const fellBack = add(thread, "steer-fellback", "steer me", { delivery: "steer" });
for (const header of intents.headers(thread))
  if (header.id === fellBack) intents.requeue(header, "Provider refused the steer");
notes.fellBack(fellBack);
add(thread, "child-result", "child", { trigger: "subagent_result" });
const uncertain = add(thread, "uncertain", "maybe ran");
queue.uncertain(uncertain);
add(thread, "removed-one", "removed");
add(thread, "cancelled-one", "cancelled");
add(thread, "done-one", "done");
for (const header of intents.headers(thread)) {
  if (header.commandId === "removed-one") intents.mark(header, "failed", "Removed from queue");
  if (header.commandId === "cancelled-one")
    intents.mark(header, "failed", "Cancelled before delivery");
  if (header.commandId === "done-one") intents.mark(header, "done");
}
queue.set(thread, { paused: true, reason: "stopped" }, at);

// The stale thread: two uncertain sends, one submitted in each generation.
const stale = createDevThread(store, workspace).id;
queue.ensure(stale);
for (const [id, text, generation] of [
  ["gen-one", "one", 1],
  ["gen-two", "two", 2],
] as const) {
  const intent = add(stale, id, text);
  for (const header of intents.headers(stale))
    if (header.id === intent) {
      intents.mark(header, "running");
      intents.submit(header, generation);
    }
  queue.uncertain(intent);
}
queue.set(stale, { paused: true, reason: "uncertain" }, at);

// E5.4c's input-fate thread: one row per rule `inputFate` checks, written by the TypeScript
// store modules the daemon uses today.
const fate = createDevThread(store, workspace).id;
const journal = new InputJournal(store);
const resent = add(fate, "resent", "sent twice");
queue.uncertain(resent);
journal.replace(fate, CommandId.parse("resent"), CommandId.parse("again"));
const uncertainFate = add(fate, "uncertain-fate", "maybe it ran");
queue.uncertain(uncertainFate);
add(fate, "waiting-fate", "still waiting");
// The journal row first: `attachRun` UPDATEs it, and a missing row would leave no run to read.
journal.register(fate, "input:waiting-fate", [{ type: "text", text: "still waiting" }], {
  kind: "person",
  commandId: CommandId.parse("waiting-fate"),
});
journal.attachRun(fate, "input:waiting-fate", "run-recorded");
const delivered = add(fate, "delivered-fate", "took a run");
for (const header of intents.headers(fate))
  if (header.id === delivered) intents.mark(header, "done");
journal.register(fate, "input:delivered-fate", [{ type: "text", text: "took a run" }], {
  kind: "person",
  commandId: CommandId.parse("delivered-fate"),
});
journal.attachRun(fate, "input:delivered-fate", "run-recorded");
add(fate, "cancelled-fate", "stopped before delivery");
add(fate, "removed-fate", "taken out of the queue");
for (const header of intents.headers(fate)) {
  if (header.commandId === "cancelled-fate")
    intents.mark(header, "failed", "Cancelled before delivery");
  if (header.commandId === "removed-fate") intents.mark(header, "failed", "Removed from queue");
}
// E5.4d's threads: a plain queue for the edit, move, remove and pause receipts; a `not_sent`
// hold whose head the person can remove; and a guest and a retired bot thread for refusals.
/** A stored state, so the receipt's `repo.state` finds the thread (a dev thread has none). */
function seedState(id: string): void {
  const state = createThreadState({
    threadId: ThreadId.parse(id),
    rootAgent: {
      agent: AgentId.parse("root"),
      fidelity: "full",
      native: { provider: "codex", nativeId: NativeSessionId.parse("native-root") },
      cwd: home ?? process.cwd(),
    },
    config: { provider: "codex", silenceMs: 30_000 },
  });
  store.atomic((db) =>
    db
      .prepare("INSERT INTO thread_state VALUES (?, ?, ?)")
      .run(id, JSON.stringify({ ...state, engineSnapshot: 9 }), store.headSeq()),
  );
}

const edits = createDevThread(store, workspace).id;
seedState(edits);
queue.ensure(edits);
add(edits, "edit-a", "first word");
add(edits, "edit-b", "second word");
add(edits, "edit-c", "third word");
const held = createDevThread(store, workspace).id;
seedState(held);
queue.ensure(held);
add(held, "held-head", "failed head");
queue.set(held, { paused: true, reason: "not_sent" }, at);
const heldBehind = createDevThread(store, workspace).id;
seedState(heldBehind);
queue.ensure(heldBehind);
add(heldBehind, "held2-head", "failed head");
add(heldBehind, "held2-behind", "behind it");
queue.set(heldBehind, { paused: true, reason: "not_sent" }, at);
const guest = createDevThread(store, workspace).id;
store.appendEvents(
  guest,
  [
    {
      type: "thread.client.updated",
      changes: { details: { guest: { host: "peer", name: "Rijan's MacBook" } } },
    },
  ],
  at,
);
const bot = createDevThread(store, workspace).id;
store.appendEvents(bot, [{ type: "thread.client.updated", changes: { host: "spade-bot" } }], at);

// `input:cancelled-fate` was written before its delivery stopped it; `input:written` has no
// intent at all; `input:delivered-fate` was written and the journal hands it a run.
for (const [id, text] of [
  ["input:cancelled-fate", "stopped before delivery"],
  ["input:written", "delivered with no intent"],
  ["input:delivered-fate", "took a run"],
] as const)
  store.appendEvents(fate, [
    {
      type: "item.created",
      item: Item.parse({
        id,
        agentId: "root",
        type: "message",
        role: "user",
        parts: [{ type: "text", text }],
        createdAt: at,
        complete: true,
      }),
    },
  ]);
