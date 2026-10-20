import { WebSocket } from "ws";
import type { BrowserServerMessage } from "@ace/protocol";
import { mayCompress } from "../compression-policy.ts";

type FrameSocket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "terminate">;

/**
 * Live video waits (the fanout keeps it) while this much output waits on the socket: about a
 * quarter second of 16 Mbit/s video, room for a phone link's round trip, and far below the
 * 4 MiB at which reliable messages give up on the connection.
 */
const frameBacklogBytes = 512 * 1024;

/** Browser frames yield to control traffic on the app's shared socket. */
export function sendBrowserMessage(
  socket: FrameSocket,
  message: BrowserServerMessage,
  serialized?: string,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (message.type === "browser.frame") {
    if (socket.bufferedAmount > frameBacklogBytes) return false;
  } else if (socket.bufferedAmount > 4 * 1024 * 1024) {
    // Correlated replies and control changes cannot be dropped on a live connection.
    // A graceful close frame would wait behind the same buffered output.
    socket.terminate();
    return false;
  }
  // Frames in JSON (older viewers) stay uncompressed: a deflate per frame per viewer costs CPU
  // that binary frames make unnecessary.
  socket.send(serialized ?? JSON.stringify(message), { compress: mayCompress(message.type) });
  return true;
}

/**
 * One frame's binary stream messages, all of them or none. A JPEG is already compressed, so
 * per-message deflate never runs on it.
 */
export function sendBrowserStream(socket: FrameSocket, pieces: readonly Uint8Array[]): boolean {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > frameBacklogBytes)
    return false;
  for (const piece of pieces) socket.send(piece, { binary: true, compress: false });
  return true;
}
