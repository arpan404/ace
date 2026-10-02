import { messageChannel } from "./channel.ts";
import type { ClientChannel } from "./channel.ts";
import { dial, relayAddress } from "./socket.ts";
import { handshake, STREAM_PROLOGUE } from "./handshake.ts";
export async function connectClientViaRelay(options: {
  relayUrl: string;
  hostId: string;
  pinnedFingerprint: string;
  signal?: AbortSignal;
}): Promise<ClientChannel> {
  if (options.hostId !== options.pinnedFingerprint || !/^[A-Z2-7]{52}$/.test(options.hostId))
    throw new Error("Host id must match pinned fingerprint");
  const { socket, reader } = await dial(
    relayAddress(options.relayUrl, "/client", { hostId: options.hostId }),
    options.signal,
  );
  const timeout = setTimeout(() => socket.terminate(), 10000);
  try {
    const ready = await reader.next();
    if (ready.length !== 1 || ready[0] !== 1) throw new Error("Invalid relay pairing marker");
    const transport = await handshake(socket, reader, {
      initiator: true,
      pinnedFingerprint: options.pinnedFingerprint,
      prologue: STREAM_PROLOGUE,
    });
    return messageChannel(socket, reader, transport, false);
  } catch (error) {
    socket.terminate();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
