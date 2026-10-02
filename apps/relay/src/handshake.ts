import { NoiseXX, keyPair } from "@ace/secure-channel";
import type { KeyPair, Transport } from "@ace/secure-channel";
import type WebSocket from "ws";
import { FrameReader, sendFrame } from "./socket.ts";
export const CONTROL_PROLOGUE = new TextEncoder().encode("ace relay registration v1");
export const STREAM_PROLOGUE = new TextEncoder().encode("ace daemon relay stream v1");
export async function handshake(
  socket: WebSocket,
  reader: FrameReader,
  options: {
    initiator: boolean;
    staticKey?: KeyPair;
    pinnedFingerprint?: string;
    prologue: Uint8Array;
  },
): Promise<Transport> {
  const state = new NoiseXX({ ...options, staticKey: options.staticKey ?? keyPair() });
  const timeout = setTimeout(() => socket.terminate(), 10000);
  try {
    if (options.initiator) {
      await sendFrame(socket, state.writeMessage());
      state.readMessage(await reader.next());
      await sendFrame(socket, state.writeMessage());
    } else {
      state.readMessage(await reader.next());
      await sendFrame(socket, state.writeMessage());
      state.readMessage(await reader.next());
    }
    return state.transport;
  } catch (error) {
    state.destroy();
    socket.terminate();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
