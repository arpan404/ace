import { WebSocket } from "ws";
import type { BrowserServerMessage } from "@ace/protocol";

/** Browser frames yield to control traffic on the app's shared socket. */
export function sendBrowserMessage(
  socket: Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "terminate">,
  message: BrowserServerMessage,
  serialized?: string,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (message.type === "browser.frame") {
    if (socket.bufferedAmount > 256 * 1024) return false;
  } else if (socket.bufferedAmount > 4 * 1024 * 1024) {
    // Correlated replies and control changes cannot be dropped on a live connection.
    // A graceful close frame would wait behind the same buffered output.
    socket.terminate();
    return false;
  }
  socket.send(serialized ?? JSON.stringify(message));
  return true;
}
