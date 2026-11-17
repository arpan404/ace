import { HostId, type DeviceId, type MachineRelayCall } from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { MachineTarget } from "./machines/target.ts";
import type { PairedDevice } from "./devices.ts";

/** Calls a machine takes through a relay (ADR 0182): parcels, and `describe` to learn paths. */
const relayedOps: ReadonlySet<string> = new Set(["parcel", "describe"]);
/** Calls answered at once on one stream; more wait for a free one. */
const PARALLEL = 4;

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
  let running = 0;
  const waiting: (() => void)[] = [];
  const serve = async (call: MachineRelayCall) => {
    if (running >= PARALLEL) {
      // A peer that keeps sending past this is refused rather than queued without end.
      if (waiting.length >= 32) {
        await channel
          .send({
            type: "machine.answer",
            id: call.id,
            status: 503,
            body: { error: "unavailable" },
          })
          .catch(() => {});
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
    try {
      const device = options.device();
      const target = options.target();
      const answer = !device
        ? { status: 401, body: { error: "unauthorized" } }
        : !target
          ? { status: 503, body: { error: "unavailable" } }
          : !relayedOps.has(call.request.call.op)
            ? {
                status: 501,
                body: {
                  error: "not_supported",
                  message: "Through a relay this machine takes only parcels.",
                },
              }
            : await target.handle(device, call.request, lifetime.signal);
      await channel
        .send({ type: "machine.answer", id: call.id, status: answer.status, body: answer.body })
        .catch(() => {});
    } catch {
      await channel
        .send({ type: "machine.answer", id: call.id, status: 500, body: { error: "unavailable" } })
        .catch(() => {});
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
  for await (const frame of channel.frames()) {
    if (frame instanceof Uint8Array) continue;
    if (frame.type === "ping") await channel.send({ type: "pong" });
    else if (frame.type === "machine.call") void serve(frame);
  }
}
