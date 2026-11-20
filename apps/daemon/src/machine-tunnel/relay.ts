import type { ServerMessage, TunnelRefusalCode } from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { TunnelAttachment, TunnelHost } from "./host.ts";

/**
 * A device's tunnel connection through a relay (ADR 0194): an authorized relay channel whose
 * hello named `channel: "tunnel"`. It is welcomed, handed to the tunnel host, and read until it
 * closes: binary messages are the mux's frames, pings are answered, anything else is ignored.
 */
export async function serveRelayTunnel(
  channel: Pick<
    HostChannel,
    "send" | "sendBinary" | "close" | "frames" | "bufferedBytes" | "bufferedReceiveBytes"
  >,
  host: TunnelHost,
  options: {
    device: string;
    operate(): boolean;
    welcome: Extract<ServerMessage, { type: "welcome" }>;
    /**
     * The connection, for the relay to refuse it (a revoked device), from before its welcome is
     * sent: a refusal made meanwhile reaches the device after the welcome, as one made later does.
     */
    attached?(attachment: TunnelAttachment): void;
  },
): Promise<void> {
  let served: TunnelAttachment | undefined;
  let refusal: TunnelRefusalCode | undefined;
  options.attached?.({
    refuse(code) {
      if (served) served.refuse(code);
      else refusal ??= code;
    },
  });
  await channel.send(options.welcome);
  let frames: ((frame: Uint8Array) => void) | undefined;
  let lost: (() => void) | undefined;
  const attachment = host.attach({
    device: options.device,
    operate: options.operate,
    // One send queue carries both, so a refusal stays ahead of its RESET.
    sendJson: (message) => channel.send(message),
    channel: {
      send: (frame) => channel.sendBinary(frame),
      close: () => channel.close(),
      subscribe(onFrame, onClose) {
        frames = onFrame;
        lost = onClose;
        return () => {
          frames = undefined;
          lost = undefined;
        };
      },
      get bufferedBytes() {
        return channel.bufferedBytes;
      },
      get bufferedReceiveBytes() {
        return channel.bufferedReceiveBytes;
      },
    },
    close: () => channel.close(),
  });
  served = attachment;
  if (refusal) attachment.refuse(refusal);
  try {
    for await (const frame of channel.frames()) {
      if (frame instanceof Uint8Array) frames?.(frame);
      else if (frame.type === "ping") await channel.send({ type: "pong" });
    }
  } finally {
    lost?.();
  }
}
