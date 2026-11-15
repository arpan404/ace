import type { Credential } from "@ace/client";
import type { OpenMediaRelay } from "@ace/client/media";
import { ClientMessage, mediaCloseCodes } from "@ace/protocol";
import { z } from "zod";
import { nativeMediaSocket } from "./socket.ts";

/*
 * A media connection through the relay on the phone (ADR 0147 §5.2): Swift's relay socket opens
 * a stream with the `media` purpose and runs its Noise handshake, pinned to the machine's host
 * key; this sends the stream's hello (`channel: "media"` with the `media.connect` ticket and this
 * device's credential, as the main channel's hello carries it) and waits for the daemon's
 * welcome. From then on the daemon has handed the stream to ace-media, and the shared
 * `MediaConnection` carries acks and pings on it while Swift draws its pictures.
 */

export interface PhoneMediaRelayOptions {
  deviceId: string;
  /** The machine's host id its welcome must name; undefined where the native pin is the check. */
  expectedHostId?: string | undefined;
  credential(): Promise<Credential>;
}

const Welcome = z.looseObject({ type: z.literal("welcome"), hostId: z.string().optional() });

export function nativeMediaRelay(options: PhoneMediaRelayOptions): OpenMediaRelay {
  return (ticket, events) => {
    const socket = nativeMediaSocket(undefined);
    let welcomed = false;
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      socket.close();
      events.close(code);
    };
    const welcome = (text: string): boolean => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return false;
      }
      const parsed = Welcome.safeParse(value);
      if (!parsed.success) return false;
      return options.expectedHostId === undefined || parsed.data.hostId === options.expectedHostId;
    };
    socket.open({
      open() {
        options
          .credential()
          .then((credential) => {
            if (ended) return;
            const hello = ClientMessage.parse({
              type: "hello",
              protocolVersion: 1,
              deviceId: options.deviceId,
              ...(typeof credential === "string" ? { token: credential } : credential),
              channel: "media",
              mediaTicket: ticket,
              flowControl: ["credit"],
            });
            socket.send(JSON.stringify(hello));
          })
          .catch(() => end(1006));
      },
      message(text) {
        if (welcomed) return events.message(text);
        // Anything but the daemon's welcome first is a refusal: a spent or foreign ticket.
        if (!welcome(text)) return end(mediaCloseCodes.refused);
        welcomed = true;
        events.welcome();
      },
      binary(bytes) {
        if (welcomed) events.message(bytes);
      },
      close(code) {
        if (ended) return;
        ended = true;
        events.close(code);
      },
    });
    return {
      send(data) {
        if (ended) throw new Error("Media relay stream isn't open");
        if (typeof data !== "string") throw new Error("A media relay stream sends text only");
        socket.send(data);
      },
      close: () => end(1000),
    };
  };
}
