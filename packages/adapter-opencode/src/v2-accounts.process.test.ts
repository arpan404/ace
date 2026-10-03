import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { createOpenCodeAdapter } from "./index.ts";
import { setup, deferred } from "./testing/v2-session.ts";
import { object } from "./data.ts";

it("sessions in one account share a server and cancelling one keeps its peer usable", async () => {
  const boundary = await setup();
  const adapter = createOpenCodeAdapter(boundary.options);
  const firstSignal = new AbortController(),
    peerSignal = new AbortController();
  const exited = deferred<void>();
  const firstFrames: Frame[] = [],
    peerFrames: Frame[] = [],
    otherFrames: Frame[] = [];
  const open = (instanceId: string, signal: AbortSignal, frames: Frame[], onExit = () => {}) =>
    adapter.openSession({
      threadId: ThreadId.parse(`thread_${instanceId}`),
      cwd: "/account",
      instanceId,
      env: { ACE_TEST_INSTANCE: instanceId },
      signal,
      onFrame: (f) => frames.push(f),
      onExit,
    });
  try {
    const first = await open("account-a", firstSignal.signal, firstFrames, () => exited.resolve());
    const peer = await open("account-a", peerSignal.signal, peerFrames);
    expect(await boundary.control("/test/instance")).toEqual({ instance: "account-a" });
    // Independent fake processes reuse session-1; a shared process allocates distinct sessions.
    await first.send([{ type: "text", text: "first" }], "queue", "first-command");
    await peer.send([{ type: "text", text: "peer" }], "queue", "peer-command");
    expect(first.nativeSessionId).not.toBe(peer.nativeSessionId);
    firstSignal.abort();
    await exited.promise;
    await peer.send([{ type: "text", text: "survives" }], "steer", "survivor-command");
    expect(peer.instanceId).toBe("account-a");
    expect(
      peerFrames.some(
        (f) => f.channel === "input.sending" && object(f.data).commandId === "survivor-command",
      ),
    ).toBe(true);
    const other = await open("account-b", new AbortController().signal, otherFrames);
    expect(other.instanceId).toBe("account-b");
    expect(other.nativeSessionId).toBe("session-1");
    expect(await boundary.control("/test/instance")).toEqual({ instance: "account-b" });
    await expect(
      adapter.openSession({
        cwd: "/account",
        threadId: ThreadId.parse("thread_changed_account"),
        instanceId: "account-a",
        env: { ACE_TEST_INSTANCE: "changed" },
        signal: new AbortController().signal,
        onFrame: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow("environment changed");
    await peer.send([{ type: "text", text: "still same account" }], "queue");
    expect(await boundary.control("/test/instance")).toEqual({ instance: "account-a" });
  } finally {
    await adapter.close();
  }
});
