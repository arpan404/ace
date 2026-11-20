import type { ClientMessage } from "@ace/protocol";
import type { TunnelAttachment } from "../machine-tunnel/host.ts";
import type { SocketContext, SocketService } from "./socket.ts";

type Channel = Extract<ClientMessage, { type: "hello" }>["channel"];

/**
 * A device's tunnel connection on the daemon's own listeners (ADR 0194): a socket whose hello
 * named `channel: "tunnel"`. Once welcomed it is handed to the machine's tunnel host; its
 * binary messages are the mux's frames, and nothing else on it is served.
 */
export function createTunnelSession(context: SocketContext): SocketService {
  let channel: Channel;
  let frames: ((frame: Uint8Array) => void) | undefined;
  let lost: (() => void) | undefined;
  let attachment: TunnelAttachment | undefined;
  const send = (data: string | Uint8Array, binary: boolean) =>
    new Promise<void>((resolve, reject) => {
      if (!context.connected()) {
        reject(new Error("Tunnel socket closed"));
        return;
      }
      // Straight to the socket, never the outbox, so a refusal stays ahead of its RESET.
      context.socket.send(data, { binary, compress: false }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  const close = () => {
    if (context.connected()) context.socket.close(1000, "Tunnel closed");
  };
  return {
    authenticated(kind) {
      channel = kind;
    },
    welcomed() {
      if (channel !== "tunnel") return;
      const host = context.options.machineTunnel;
      const device = context.device();
      if (!host || !device) {
        context.socket.close(1011, "service_unavailable");
        return;
      }
      attachment = host.attach({
        device,
        operate: () => context.connected() && context.authorize("operate"),
        sendJson: (message) => send(JSON.stringify(message), false),
        channel: {
          send: (frame) => send(frame, true),
          close,
          subscribe(onFrame, onClose) {
            frames = onFrame;
            lost = onClose;
            return () => {
              frames = undefined;
              lost = undefined;
            };
          },
          get bufferedBytes() {
            return context.socket.bufferedAmount;
          },
        },
        close,
      });
    },
    binary(frame) {
      if (channel !== "tunnel") return false;
      frames?.(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
      return true;
    },
    revoked() {
      // The refusal goes ahead of the close frame, on the same socket.
      attachment?.refuse("tunnel_forbidden");
    },
    close() {
      lost?.();
    },
  };
}
