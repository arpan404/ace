import {
  HostId,
  type DeviceId,
  type MachineRelayCall,
  type MachineRelayTransfer,
} from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { MachineTarget } from "./machines/target.ts";
import { laneOf } from "./machines/transport.ts";
import type { PairedDevice } from "./devices.ts";
import { TargetRefusal } from "./machines/target-refusal.ts";
import { hostedRelayCarries, hostedRelayRefusal } from "./transfers/route-policy.ts";
import {
  answerTransfer,
  deviceNow,
  refused,
  type TransferRequest,
  type TransferTarget,
} from "./transfers/serve.ts";

/** Calls answered at once on one stream; more wait for a free one. */
const PARALLEL = 4;
/** Urgent calls (cancel, an answer for the person, a command stop) run beside them, up to this. */
const URGENT = 4;

/**
 * Serves machine calls on an authenticated relay stream (`hello.channel: "machine"`). The relay
 * host already checked the hello's paired-device token; every call reads the device again, so
 * revoking or re-pairing it refuses the next call, and the same target the TLS listener uses
 * decides it (pairing, grants, ceilings). Account devices never come here: machine calls are
 * between paired machines only. Transfer calls (`machine.transfer`, ADR 0192) share the stream's
 * slots and are decided as on the TLS listener's `/v1/transfers`, never as machine calls.
 */
export async function serveRelayMachineCalls(
  channel: HostChannel,
  options: {
    target(): Pick<MachineTarget, "handle"> | undefined;
    /** This machine's end of transfers; without it, the welcome doesn't offer them. */
    transfers?: (() => TransferTarget | undefined) | undefined;
    /**
     * The stream came through ace's hosted relay, by this machine's own settings: it takes only
     * what that relay may carry (ADR 0192), whatever the sender decided.
     */
    hostedRelay?: boolean | undefined;
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
    ...(options.transfers ? { machineTransfers: true as const } : {}),
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
  const serve = async (call: MachineRelayCall | MachineRelayTransfer) => {
    const stop = new AbortController();
    calls.set(call.id, stop);
    const deadline = call.timeoutMs ? setTimeout(() => stop.abort(), call.timeoutMs) : undefined;
    deadline?.unref();
    // A cancel, an answer for the person or a command stop never waits behind long work.
    const isUrgent = call.type === "machine.call" && laneOf(call.request.call) === "urgent";
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
      const result = !device
        ? { status: 401, body: { error: "unauthorized" } }
        : await run(call, device, AbortSignal.any([lifetime.signal, stop.signal]));
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
  const run = async (
    call: MachineRelayCall | MachineRelayTransfer,
    device: PairedDevice,
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown }> => {
    if (call.type === "machine.call") {
      const target = options.target();
      return target
        ? target.handle(device, call.request, signal)
        : { status: 503, body: { error: "unavailable" } };
    }
    const owner = options.transfers?.();
    if (!owner) return { status: 503, body: { error: "unavailable" } };
    const request = transferRequest(call);
    if (options.hostedRelay && !hostedRelayCarries(request))
      return refused(owner, device, new TargetRefusal("not_supported", hostedRelayRefusal, true));
    // As on the TLS listener: the device is read again right before each write or import.
    return answerTransfer(
      owner,
      device,
      request,
      deviceNow(() => options.device()),
    );
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
    else if (frame.type === "machine.transfer" && options.transfers) void serve(frame);
    else if (frame.type === "machine.cancel") calls.get(frame.id)?.abort();
  }
}

/** A relay transfer frame as the target takes a transfer call; a chunk's bytes are base64. */
function transferRequest(frame: MachineRelayTransfer): TransferRequest {
  const { request } = frame;
  if (request.kind === "call") return request;
  return { ...request, data: Buffer.from(request.data, "base64") };
}
