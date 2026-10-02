import { clientMessageChannel } from "./channel.ts";
import type { ClientChannel } from "./channel.ts";
import { dial, relayAddress } from "./socket.ts";
import { initiateHandshake, STREAM_PROLOGUE } from "./handshake.ts";
import { HostId } from "./config.ts";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
export async function connectClientViaRelay(options: {
  relayUrl: string;
  hostId: string;
  pinnedFingerprint: string;
  signal?: AbortSignal;
  clock?: Clock;
}): Promise<ClientChannel> {
  if (HostId.parse(options.hostId) !== HostId.parse(options.pinnedFingerprint))
    throw new Error("Host id must match pinned fingerprint");
  const clock = options.clock ?? systemClock();
  const { socket, reader } = await dial(
    relayAddress(options.relayUrl, "/client", { hostId: options.hostId }),
    options.signal,
    clock,
  );
  const cancel = clock.schedule(10000, () => socket.terminate());
  try {
    const ready = await reader.next();
    if (ready.length !== 1 || ready[0] !== 1) throw new Error("Invalid relay pairing marker");
    const transport = await initiateHandshake(socket, reader, {
      pinnedFingerprint: options.pinnedFingerprint,
      prologue: STREAM_PROLOGUE,
      clock,
      timeoutMs: 10000,
    });
    return clientMessageChannel(socket, reader, transport);
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    cancel();
  }
}
