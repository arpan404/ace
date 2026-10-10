import { WebSocket } from "ws";
import type { BrowserServerMessage } from "@ace/protocol";

/** Browser frames yield to control traffic on the app's shared socket. */
export function sendBrowserMessage(
  socket: Pick<WebSocket, "readyState" | "bufferedAmount" | "send">,
  message: BrowserServerMessage,
  serialized?: string,
): boolean {
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount > (message.type === "browser.frame" ? 256 * 1024 : 4 * 1024 * 1024)
  )
    return false;
  socket.send(serialized ?? JSON.stringify(message));
  return true;
}
