/*
 * A live move (ADR 0191) seen by app windows of two releases at once. A process test because
 * the moved status reaches a socket through the daemon's whole fan-out (list patches, thread
 * events, snapshots); which value each client reads is tested in projection's older-status.
 */
import { expect, it, vi } from "vitest";
import { ServerMessage, type ThreadId } from "@ace/protocol";
import { supportedWireTrims, wireTrims } from "@ace/projection/wire-trim";
import { continueOn, workingThread } from "./transfer-live-support.ts";
import { transferMachines } from "./transfer-test-support.ts";

/** What the release before the moved status listed in its hello. */
const previousRelease = supportedWireTrims.filter((trim) => trim !== wireTrims.movedStatus);

/** What a client before ADR 0191 can't decode: a thread status, or a search hit's, of `moved`. */
const unreadableBeforeMove = (text: string) => /"(state|status)":"moved"/.test(text);

type Window = Awaited<ReturnType<Awaited<ReturnType<typeof transferMachines>>["sourceWindow"]>>;

function watch(window: Window, threadId: ThreadId) {
  window.send({ type: "subscribe", subscriptionId: "list", scope: { kind: "threads" } });
  window.send({ type: "subscribe", subscriptionId: "thread", scope: { kind: "thread", threadId } });
}

/** The newest status a window was told for `threadId`: by its list, or by the thread itself. */
function listedStatus(window: Window, threadId: ThreadId) {
  let status: unknown;
  for (const message of window.messages) {
    if (message.type === "snapshot" && message.view.kind === "thread")
      status = message.view.thread.status;
    if (message.type === "events")
      for (const event of message.events)
        if (event.payload.type === "thread.updated" && event.threadId === threadId)
          status = event.payload.status ?? status;
    if (message.type === "threads.patch") status = message.threads[threadId]?.status ?? status;
    if (message.type === "snapshot" && message.view.kind === "threads")
      status = message.view.threads[threadId]?.status ?? status;
  }
  return status;
}

it("keeps an older window connected through a live move, reading the moved thread as waiting", async () => {
  const m = await transferMachines();
  const { threadId } = await workingThread(m);
  const older = await m.sourceWindow(previousRelease);
  const current = await m.sourceWindow([...supportedWireTrims]);
  watch(older, threadId);
  watch(current, threadId);

  expect(await continueOn(m, threadId)).toMatchObject({ ok: true, threadId });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  const moved = m.source.daemon.store.getThread(threadId)?.status;
  expect(moved?.state).toBe("moved");

  // The current window reads it as it is.
  await vi.waitFor(() => expect(listedStatus(current, threadId)).toEqual(moved), {
    timeout: 10_000,
  });
  // The older one reads it as waiting on work elsewhere, still told where that work went.
  await vi.waitFor(
    () => expect(listedStatus(older, threadId)).toEqual({ state: "waiting", on: "upstream" }),
    { timeout: 10_000 },
  );
  const reopened = await m.sourceWindow(previousRelease);
  watch(reopened, threadId);
  await vi.waitFor(
    () => expect(listedStatus(reopened, threadId)).toEqual({ state: "waiting", on: "upstream" }),
    { timeout: 10_000 },
  );

  for (const window of [older, reopened]) {
    expect(window.open()).toBe(true);
    // Every frame it got, it can read.
    for (const text of window.texts) {
      expect(unreadableBeforeMove(text), text.slice(0, 200)).toBe(false);
      expect(ServerMessage.safeParse(JSON.parse(text)).success).toBe(true);
    }
    expect(window.texts.join("\n")).toContain(`"continuedOn":{"hostId":"${m.targetHostId}"`);
  }
  expect(current.texts.some(unreadableBeforeMove)).toBe(true);
});
