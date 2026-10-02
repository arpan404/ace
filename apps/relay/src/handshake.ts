import { NoiseXX, keyPair } from "@ace/secure-channel";
import type { KeyPair, Transport } from "@ace/secure-channel";
import type { WebSocket } from "ws";
import type { Clock } from "./clock.ts";
import { FrameReader, sendFrame } from "./socket.ts";
export const CONTROL_PROLOGUE = new TextEncoder().encode("ace relay registration v1");
export const STREAM_PROLOGUE = new TextEncoder().encode("ace daemon relay stream v1");
type Options = {
  staticKey?: KeyPair;
  pinnedFingerprint?: string;
  prologue: Uint8Array;
  clock: Clock;
  timeoutMs: number;
};
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
    state.readMessage(await reader.next());
    await sendFrame(socket, state.writeMessage());
  });
}
export function respondHandshake(
  socket: WebSocket,
  reader: FrameReader,
  options: Options,
): Promise<Transport> {
  const state = new NoiseXX({
    ...options,
    initiator: false,
    staticKey: options.staticKey ?? keyPair(),
    ephemeralKey: keyPair(),
  });
  return owned(socket, state, options, async () => {
    state.readMessage(await reader.next());
    await sendFrame(socket, state.writeMessage());
    state.readMessage(await reader.next());
  });
}
