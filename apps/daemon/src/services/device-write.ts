import type { DeviceServerMessage } from "@ace/protocol";
import { mayCompress } from "../compression-policy.ts";
import type { MainSocket } from "../main-socket.ts";

/** One devices message on the client's socket; settles when the socket has taken it. */
export function writeDeviceMessage(
  socket: MainSocket,
  message: DeviceServerMessage,
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    socket.send(JSON.stringify(message), { compress: mayCompress(message.type) }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
