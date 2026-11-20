/*
 * Locked use's gate as this daemon wires it (`computer-locked-use.ts`): the turn a protected
 * interval is scoped to is the calling agent's running run, read from a real engine. A process
 * test because the turn comes from real engine state a scripted provider session drives; the
 * gate's own decisions are unit tested in `@ace/screen`.
 */
import { expect, test } from "vitest";
import { computerLockedUseGate } from "./computer-locked-use.ts";
import type { Engine } from "./engine/index.ts";
import { end, harness, scriptFrames, start } from "./engine/test-support.ts";

/** The Mac is locked, locked use is on and installed: every call in a turn runs protected. */
function lockedMac(engine: Engine) {
  const protectedTurns: string[] = [];
  let unprotected = 0;
  const gate = computerLockedUseGate({
    engine,
    settings: { get: async () => ({ value: true }) } as never,
    computer: { helperProcessId: async () => 4242 } as never,
    lockedUseRuntime: {
      intervalActive: () => false,
      refresh: async () => ({ session: "locked", installation: { verified: true } }),
      runUnprotected: <T>(send: () => Promise<T>) => {
        unprotected++;
        return send();
      },
      runProtected: <T>(
        scope: { turnID: string },
        _pids: readonly number[],
        work: (signal: AbortSignal) => Promise<T>,
        signal: AbortSignal,
      ) => {
        protectedTurns.push(scope.turnID);
        return work(signal);
      },
    } as never,
  });
  if (!gate) throw new Error("No gate");
  return { gate, protectedTurns, unprotected: () => unprotected };
}

test("a request from a turn that already ended never enters the protected unlock interval", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    await h.engine.flush();
    const agentId = h.store.getThread(id)?.rootAgentId;
    if (!agentId) throw new Error("No root agent");
    const mac = lockedMac(h.engine);
    const call = {
      threadId: id,
      agentId,
      app: "com.apple.Notes",
      signal: AbortSignal.timeout(5_000),
    };
    // During the turn: protected, scoped to that turn's run.
    await mac.gate(call, async () => "done");
    expect(mac.protectedTurns).toHaveLength(1);
    // The turn ends; a request still attributed to it arrives late.
    await h.contexts.at(-1)?.onFrame(frames.frame(end));
    await h.engine.flush();
    await mac.gate(call, async () => "late");
    // No turn is running, so the Mac is not unlocked for it: sent as without locked use.
    expect(mac.protectedTurns).toHaveLength(1);
    expect(mac.unprotected()).toBe(1);
  } finally {
    await h.close();
  }
});
