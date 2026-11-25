// SPDX-License-Identifier: Apache-2.0
/**
 * The TypeScript engine writes the home `commands-home.process.test.ts` reads (E5.4a): a queue
 * with three waiting sends (one a steer that fell back), an uncertain one, a child result and a
 * `stopped` hold; three settled intents; a thread whose uncertain sends were submitted in two
 * generations; and E5.4c's input-fate thread, one row per fate rule. No provider CLI and no
 * daemon: the TypeScript store modules write the rows, and the parent's native engine reads them.
 */
import { join } from "node:path";
import { Command, CommandId, Item, type ThreadId } from "@ace/protocol";
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
journal.attachRun(fate, "input:waiting-fate", "run-recorded");
add(fate, "cancelled-fate", "stopped before delivery");
add(fate, "removed-fate", "taken out of the queue");
for (const header of intents.headers(fate)) {
  if (header.commandId === "cancelled-fate")
    intents.mark(header, "failed", "Cancelled before delivery");
  if (header.commandId === "removed-fate") intents.mark(header, "failed", "Removed from queue");
}
// `input:cancelled-fate` was written before its delivery failed; `input:written` has no intent.
for (const [id, text] of [
  ["input:cancelled-fate", "stopped before delivery"],
  ["input:written", "delivered with no intent"],
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
