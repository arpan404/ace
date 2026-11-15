import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Command,
  ThreadId,
  type AgentControlOperation,
  type CommandPayload,
  type Item,
} from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { ThreadLifecycle } from "../thread-lifecycle.ts";
import { digest } from "./child-views.ts";
import { gatedTransport, pairedMachines } from "./machine-test-support.ts";

type Pair = Awaited<ReturnType<typeof pairedMachines>>;

const Delegated = z.object({ threadId: ThreadId });
const delegation = {
  op: "delegate_task",
  requestId: "review-on-studio",
  task: "Summarize the open pull requests",
  role: "Review-open-pull-requests",
  provider: "claude",
  machine: "studio",
  project: "project",
} satisfies AgentControlOperation;

const result = "**Two** pull requests are ready to merge: `#12` and `#14`.";
/** The result as the parent's agent receives it, inside ace's JSON line. */
const received = JSON.stringify(result).slice(1, -1);

function parentItems(pair: Pair): Item[] {
  const store = pair.source.daemon.store;
  return store.readItemPage(pair.source.caller.threadId, store.headSeq() + 1, 50, 256 * 1024).items;
}
const receipts = (pair: Pair) =>
  parentItems(pair).filter((item) => item.type === "delegation.settled");
const parentInputs = (pair: Pair) => pair.source.h.inputs.get(pair.source.caller.threadId) ?? [];

/** The person acts on the parent thread here, as the app does. */
function person(pair: Pair, payload: CommandPayload) {
  const engine = pair.source.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const command = Command.parse({ id: `person-${randomUUID()}`, deviceId: "person", payload });
  const store = pair.source.daemon.store;
  return store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, commandContext(store)),
  );
}

async function delegated(pair: Pair) {
  await pair.source.call({ op: "machines" });
  return Delegated.parse((await pair.source.call(delegation)).data).threadId;
}

it("a finished child on a paired machine reaches its parent as one delegated-child receipt, however often the provider echoes it", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const parent = pair.source.caller.threadId;
  const threadId = await delegated(pair);

  // Nobody waits on it: the result is handed to the parent once the child finishes there.
  await pair.finishTask(threadId, delegation.task, result);

  // The parent's agent is still told, with the child's result in what it receives.
  await vi.waitFor(() => expect(parentInputs(pair).join("\n")).toContain(received), {
    timeout: 15_000,
  });
  const sent = pair.source.h.inputMessages.get(parent)?.at(-1);
  const text = parentInputs(pair).at(-1);
  if (!sent || !text) throw new Error("The result never reached the parent's provider");
  expect(text).toContain("[ace-origin:delegation.settled:");

  // The provider echoes the injected input back as a user message, with its own extra data.
  const echo = (type: "item.upsert" | "item.reconciled", item: string) => ({
    type,
    agent: "root",
    item,
    draft: {
      type: "message" as const,
      nativeId: sent.nativeId,
      role: "user" as const,
      parts: [{ type: "text" as const, text }],
      raw: [{ type: "userMessage", data: { extra: "provider-only detail" } }],
      complete: true,
    },
  });
  pair.source.h.contexts
    .get(parent)
    ?.onFrame(pair.source.h.frames.frame(echo("item.upsert", "provider-echo")));
  await pair.source.daemon.engine?.flush();

  // After a restart the provider replays its history, the echo with it.
  await pair.restartSource();
  expect(
    person(pair, {
      type: "thread.send",
      threadId: parent,
      input: [{ type: "text", text: "Continue" }],
    }).ok,
  ).toBe(true);
  await vi.waitFor(() => expect(parentInputs(pair)).toContain("Continue"), { timeout: 15_000 });
  pair.source.h.contexts
    .get(parent)
    ?.onFrame(pair.source.h.frames.frame(echo("item.reconciled", "replayed-echo")));
  await pair.source.daemon.engine?.flush();

  // The transcript shows it the way a local child's result shows: exactly one receipt for the
  // child, holding the provider's extra data, next to the child's row that names its machine.
  const shown = receipts(pair);
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatchObject({
    origin: "ace",
    delivery: "ace-input",
    results: [{ threadId, outcome: "completed", result }],
    raw: [{ type: "userMessage", data: { extra: "provider-only detail" } }],
  });
  const items = parentItems(pair);
  expect(items).toContainEqual(
    expect.objectContaining({
      type: "delegation.started",
      childThreadId: threadId,
      machine: expect.objectContaining({ name: "Studio" }),
    }),
  );
  // What was injected for the provider is never a message of its own in the transcript.
  const messages = items.filter((item) => item.type === "message" && item.role === "user");
  expect(JSON.stringify(messages)).not.toContain(received);
  expect(JSON.stringify(items)).not.toContain("[ace: ");
}, 60_000);

/**
 * The person stops the parent and its tree: the child on the other machine is cancelled there,
 * and its result comes back while the parent is still stopped. Returns the child.
 */
async function settledUnderStoppedParent(pair: Pair): Promise<ThreadId> {
  const parent = pair.source.caller.threadId;
  const threadId = await delegated(pair);
  await vi.waitFor(() => expect(pair.target.h.contexts.get(threadId)).toBeDefined(), {
    timeout: 15_000,
  });
  expect(person(pair, { type: "thread.interrupt", threadId: parent, cascade: true }).ok).toBe(true);
  await pair.source.daemon.engine?.flush();
  await pair.emit(threadId, { type: "turn.ended", agent: "root", outcome: "interrupted" });
  await vi.waitFor(
    () =>
      expect(parentItems(pair)).toContainEqual(
        expect.objectContaining({
          type: "delegation.started",
          childThreadId: threadId,
          phase: "settled",
        }),
      ),
    { timeout: 15_000 },
  );
  return threadId;
}

/** The person sends the parent on again: the child's result reaches it then, once. */
async function resumedOnce(pair: Pair, threadId: ThreadId) {
  const parent = pair.source.caller.threadId;
  const send = { type: "thread.send" as const, threadId: parent };
  expect(person(pair, { ...send, input: [{ type: "text", text: "Go on" }] }).ok).toBe(true);
  await vi.waitFor(() => expect(receipts(pair)).toHaveLength(1), { timeout: 15_000 });
  expect(receipts(pair)[0]).toMatchObject({
    delivery: "ace-input",
    results: [expect.objectContaining({ threadId })],
  });
  await vi.waitFor(
    () => expect(parentInputs(pair).filter((text) => text.includes(threadId))).toHaveLength(1),
    { timeout: 15_000 },
  );
}

it("a stopped parent shows no receipt for a remote result it hasn't taken, and gets it once it runs again", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const threadId = await settledUnderStoppedParent(pair);
  // Polls go by and each delivery is refused: nothing claims the stopped parent was told.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(receipts(pair)).toEqual([]);
  expect(parentInputs(pair).join("\n")).not.toContain(threadId);
  await resumedOnce(pair, threadId);
}, 60_000);

it("a remote result refused before refusals were retried still reaches its parent once it runs again", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const threadId = await settledUnderStoppedParent(pair);
  // An older daemon kept the stopped parent's refusal of this result as the send's final answer.
  const store = pair.source.daemon.store;
  store.atomic((db) => {
    const row = z
      .object({ key: z.string() })
      .parse(db.prepare("SELECT key FROM machine_child_outbox WHERE kind='result'").get());
    const id = `machine-result:result:${digest(row.key)}`;
    db.prepare("INSERT INTO command_receipts VALUES (?, ?, ?, ?)").run(
      id,
      "ace-agent",
      0,
      JSON.stringify({ commandId: id, ok: false, error: "cancelled" }),
    );
  });
  await resumedOnce(pair, threadId);
}, 60_000);

it("a result arriving after its stopped parent was deleted ends once and is never left owed", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const parent = pair.source.caller.threadId;
  const threadId = await delegated(pair);
  await vi.waitFor(() => expect(pair.target.h.contexts.get(threadId)).toBeDefined(), {
    timeout: 15_000,
  });
  expect(person(pair, { type: "thread.interrupt", threadId: parent, cascade: true }).ok).toBe(true);
  await pair.source.daemon.engine?.flush();
  const engine = pair.source.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const lifecycle = new ThreadLifecycle({
    store: pair.source.daemon.store,
    engine,
    handler: engine.handler,
    port: 0,
    hostId: "test",
    token: "unused",
    now: pair.source.h.clock.now,
  });
  const deleted = await lifecycle.delete(
    Command.parse({
      id: `person-delete-${parent}`,
      deviceId: "person",
      payload: { type: "thread.delete", threadId: parent, force: true },
    }),
  );
  expect(deleted.ok).toBe(true);
  // The child ends there afterwards: its result has no parent left to reach.
  await pair.emit(threadId, { type: "turn.ended", agent: "root", outcome: "interrupted" });
  const owed = () =>
    pair.source.daemon.store.atomic((db) => ({
      unsent: db.prepare("SELECT 1 FROM machine_child_outbox WHERE sent=0").all().length,
      undelivered: db
        .prepare("SELECT 1 FROM machine_children WHERE id=? AND (settled=0 OR delivered=0)")
        .all(threadId).length,
    }));
  await vi.waitFor(() => expect(owed()).toEqual({ unsent: 0, undelivered: 0 }), {
    timeout: 20_000,
  });
  expect(parentInputs(pair).join("\n")).not.toContain(threadId);
}, 60_000);

it("a stopped parent's waiting result never makes the poll wake itself through the events it writes on the parent", async () => {
  const gated = gatedTransport();
  const pair = await pairedMachines({ access: "operate", sourceTransport: gated.transport });
  const threadId = await settledUnderStoppedParent(pair);
  // Each child update there wrote an agent.seen event on the parent here, which reaches the
  // children as activity on the parent. Settled now, with only its waiting result left, the
  // poll falls back to the slow re-check pace: 500 ms here, not the 50 ms poll.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = gated.statusCalls();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(gated.statusCalls() - before).toBeLessThanOrEqual(6);
  expect(receipts(pair)).toEqual([]);
  // And it still arrives, once, when the person sends the parent on.
  await resumedOnce(pair, threadId);
}, 60_000);
