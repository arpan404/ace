import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities } from "@ace/protocol";
import type { ProviderAdapter } from "@ace/engine-api";
import { INTERRUPT_GRACE_MS, KILL_GRACE_MS, TERMINATE_GRACE_MS } from "../liveness/stop.ts";
import { end, harness, scriptFrames, start } from "./test-support.ts";

/*
 * Stop is final for a local provider (ADR 0052): an interrupt the provider never answers can't
 * hold a Stop. The session closes (SIGTERM, then SIGKILL, in its adapter), and a close that never
 * answers either still ends the session, saying the provider didn't confirm.
 */

const never = () => new Promise<void>(() => {});

/** A provider that takes the turn, then hangs on interrupt and, with `closeHangs`, on close. */
function hungProvider(frames: ReturnType<typeof scriptFrames>, closeHangs: boolean) {
  const closes: string[] = [];
  const scripted = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native-1",
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: (frame) => frames.translate(frame), tick: () => [] }),
    steps: [{ on: "send", frames: [frames.frame(start)] }],
  });
  const adapter: ProviderAdapter = {
    ...scripted,
    async openSession(ctx) {
      const session = await scripted.openSession(ctx);
      const close = session.close.bind(session);
      return Object.assign(session, {
        interrupt: never,
        async close(reason: "idle" | "user" | "shutdown") {
          closes.push(reason);
          return closeHangs ? never() : close(reason);
        },
      });
    },
  };
  return { adapter, closes };
}

const live = ["working", "waiting", "needs_you", "unresponsive"];

/** Lets pending work run without waiting on the hung provider call, as flush would. */
async function turns(count = 20) {
  for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve));
}

test("a provider that never answers its interrupt is closed within the bound, and the thread is no longer working", async () => {
  const frames = scriptFrames();
  const { adapter, closes } = hungProvider(frames, false);
  const h = await harness([], frames, { nativeAdapter: adapter, silenceMs: 60_000 });
  const id = await h.create();
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");

  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await turns();
  // Inside the interrupt's grace nothing is forced yet.
  expect(closes).toEqual([]);
  h.clock.advance(h.clock.now() + INTERRUPT_GRACE_MS);
  await turns();
  expect(closes).toEqual(["user"]);
  expect(live).not.toContain(h.store.getThread(id)?.status.state);
  // Its close was confirmed: nothing of it may still run, so a live move may hand it over.
  expect(h.engine.liveMove.unconfirmedExit(id)).toBe(false);
}, 15_000);

test("a provider that hangs on both interrupt and close is still stopped once the bound passes, saying it didn't confirm", async () => {
  const frames = scriptFrames();
  const { adapter, closes } = hungProvider(frames, true);
  const h = await harness([], frames, { nativeAdapter: adapter, silenceMs: 60_000 });
  const id = await h.create();
  await turns();

  const began = h.clock.now();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await turns();
  h.clock.advance(began + INTERRUPT_GRACE_MS);
  await turns();
  expect(closes).toEqual(["user"]);
  expect(live).toContain(h.store.getThread(id)?.status.state);
  h.clock.advance(began + INTERRUPT_GRACE_MS + TERMINATE_GRACE_MS + KILL_GRACE_MS);
  await turns();
  expect(live).not.toContain(h.store.getThread(id)?.status.state);
  const notices = h.store
    .snapshotThread(id)
    .itemOrder.map((key) => h.store.snapshotThread(id).items[key])
    .flatMap((item) => (item?.type === "notice" ? [item.text] : []));
  expect(notices.join("\n")).toContain("didn't confirm");
  // Ordinary status settles it; a live move still reads that its process may run (ADR 0191).
  expect(h.engine.liveMove.unconfirmedExit(id)).toBe(true);
}, 15_000);

test("a Stop still escalating reads in flight though the provider already ended its turn", async () => {
  const frames = scriptFrames();
  const { adapter } = hungProvider(frames, true);
  const h = await harness([], frames, { nativeAdapter: adapter, silenceMs: 60_000 });
  const id = await h.create();
  await turns();

  const began = h.clock.now();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await turns();
  // The provider reports its turn ended but never answers the interrupt call itself.
  await h.contexts.at(-1)?.onFrame(frames.frame({ ...end, outcome: "interrupted" }));
  await turns();
  expect(live).not.toContain(h.store.getThread(id)?.status.state);
  expect(h.engine.liveMove.stopInFlight(id)).toBe(true);
  expect(h.engine.liveMove.unconfirmedExit(id)).toBe(false);
  h.clock.advance(began + INTERRUPT_GRACE_MS);
  await turns();
  // Closing now: still the Stop's.
  expect(h.engine.liveMove.stopInFlight(id)).toBe(true);
  h.clock.advance(began + INTERRUPT_GRACE_MS + TERMINATE_GRACE_MS + KILL_GRACE_MS);
  await turns();
  // The escalation finished: the close went unconfirmed, and the Stop is over.
  expect(h.engine.liveMove.stopInFlight(id)).toBe(false);
  expect(h.engine.liveMove.unconfirmedExit(id)).toBe(true);
}, 15_000);
