import { NoiseXX, keyPair } from "@ace/secure-channel";
import type { KeyPair, Transport } from "@ace/secure-channel";
import type { WebSocket } from "ws";
import type { Clock } from "./clock.ts";
import { FrameReader, sendFrame } from "./socket.ts";
export { CONTROL_PROLOGUE, NK_STREAM_PROLOGUE, STREAM_PROLOGUE } from "./wire.ts";
type Options = {
  staticKey?: KeyPair;
  pinnedFingerprint?: string;
  prologue: Uint8Array;
  clock: Clock;
  timeoutMs: number;
};
function readEmptyPayload(state: NoiseXX, message: Uint8Array): void {
  if (state.readMessage(message).length !== 0) throw new Error("Handshake payload must be empty");
}
async function owned(
  socket: WebSocket,
  state: NoiseXX,
  options: Options,
  exchange: () => Promise<void>,
): Promise<Transport> {
  const cancel = options.clock.schedule(options.timeoutMs, () => socket.terminate());
  try {
    await exchange();
    return state.transport;
  } catch (error) {
    state.destroy();
    socket.terminate();
    throw error;
  } finally {
    cancel();
  }
}
export function initiateHandshake(
  socket: WebSocket,
  reader: FrameReader,
  options: Options,
): Promise<Transport> {
  const state = new NoiseXX({
    ...options,
    initiator: true,
    staticKey: options.staticKey ?? keyPair(),
    ephemeralKey: keyPair(),
  });
  return owned(socket, state, options, async () => {
    await sendFrame(socket, state.writeMessage());
    readEmptyPayload(state, await reader.next());
    await sendFrame(socket, state.writeMessage());
  });
}
/** `first`: the first message, when the caller already read it to tell the patterns apart. */
export function respondHandshake(
  socket: WebSocket,
  reader: FrameReader,
  options: Options,
  first?: Uint8Array,
): Promise<Transport> {
  const state = new NoiseXX({
    ...options,
    initiator: false,
    staticKey: options.staticKey ?? keyPair(),
    ephemeralKey: keyPair(),
  });
  return owned(socket, state, options, async () => {
    readEmptyPayload(state, first ?? (await reader.next()));
    await sendFrame(socket, state.writeMessage());
    readEmptyPayload(state, await reader.next());
  });
}
