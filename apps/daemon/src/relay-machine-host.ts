import { HostId, type DeviceId, type MachineRelayCall } from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { MachineTarget } from "./machines/target.ts";
import { laneOf } from "./machines/transport.ts";
import type { PairedDevice } from "./devices.ts";

/** Calls answered at once on one stream; more wait for a free one. */
const PARALLEL = 4;
/** Urgent calls (cancel, an answer for the person, a command stop) run beside them, up to this. */
const URGENT = 4;

/**
 * Serves machine calls on an authenticated relay stream (`hello.channel: "machine"`). The relay
 * host already checked the hello's paired-device token; every call reads the device again, so
 * revoking or re-pairing it refuses the next call, and the same target the TLS listener uses
 * decides it (pairing, grants, ceilings). Account devices never come here: machine calls are
 * between paired machines only.
 */
export async function serveRelayMachineCalls(
  channel: HostChannel,
  options: {
    target(): Pick<MachineTarget, "handle"> | undefined;
    device(): PairedDevice | undefined;
    deviceId: DeviceId;
    hostId: string;
    headSeq(): number;
  },
): Promise<void> {
  await channel.send({
    type: "welcome",
    hostId: HostId.parse(options.hostId),
    protocolVersion: 1,
    headSeq: options.headSeq(),
  });
  const lifetime = new AbortController();
  void channel.closed.then(() => lifetime.abort());
  // Each call can be stopped by its caller (`machine.cancel`) or its own deadline, as a closed
  // request stops it on the TLS listener.
  const calls = new Map<number, AbortController>();
  let running = 0;
  let urgent = 0;
  const waiting: { id: number; start: () => void }[] = [];
  const answer = (id: number, status: number, body: unknown) =>
    channel.send({ type: "machine.answer", id, status, body }).catch(() => {});
  const serve = async (call: MachineRelayCall) => {
    const stop = new AbortController();
    calls.set(call.id, stop);
    const deadline = call.timeoutMs ? setTimeout(() => stop.abort(), call.timeoutMs) : undefined;
    deadline?.unref();
    // A cancel, an answer for the person or a command stop never waits behind long work.
    const isUrgent = laneOf(call.request.call) === "urgent";
    let slot: "urgent" | "work" | undefined;
    try {
      if (isUrgent) {
        if (urgent >= URGENT) return void (await answer(call.id, 503, { error: "unavailable" }));
        urgent++;
        slot = "urgent";
      } else if (running < PARALLEL) {
        running++;
        slot = "work";
      } else {
        // A peer that keeps sending past this is refused rather than queued without end.
        if (waiting.length >= 32)
          return void (await answer(call.id, 503, { error: "unavailable" }));
        // A finishing call hands its slot straight to this one; a stopped one leaves the queue.
        await new Promise<void>((resolve) => {
          waiting.push({ id: call.id, start: resolve });
          stop.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (stop.signal.aborted) {
          const at = waiting.findIndex((entry) => entry.id === call.id);
          if (at >= 0) waiting.splice(at, 1);
          else handOn();
          return;
        }
        slot = "work";
      }
      const device = options.device();
      const target = options.target();
      const result = !device
        ? { status: 401, body: { error: "unauthorized" } }
        : !target
          ? { status: 503, body: { error: "unavailable" } }
          : await target.handle(
              device,
              call.request,
              AbortSignal.any([lifetime.signal, stop.signal]),
            );
      // The caller stopped waiting: nothing is owed to it.
      if (!stop.signal.aborted) await answer(call.id, result.status, result.body);
    } catch {
      if (!stop.signal.aborted) await answer(call.id, 500, { error: "unavailable" });
    } finally {
      clearTimeout(deadline);
      calls.delete(call.id);
      if (slot === "urgent") urgent--;
      else if (slot === "work") handOn();
    }
  };
  /** A finished work slot goes to the next waiting call, or is given back. */
  function handOn() {
    const next = waiting.shift();
    if (next) next.start();
    else running--;
  }
  for await (const frame of channel.frames()) {
    if (frame instanceof Uint8Array) continue;
    if (frame.type === "ping") await channel.send({ type: "pong" });
    else if (frame.type === "machine.call") void serve(frame);
    else if (frame.type === "machine.cancel") calls.get(frame.id)?.abort();
  }
}
