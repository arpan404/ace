import { ClientMessage, mediaCloseCodes } from "@ace/protocol";
import type { AceClient } from "@ace/protocol/ace-client";
import type { OpenMediaRelay } from "./media-connection.ts";
import type { PortableRelay, PortableRelayOptions } from "./portable-relay.ts";
import { relayGrant, type Credential } from "./credentials.ts";
import { RelayClosedError } from "./relay-closed.ts";

/*
 * A media connection through the relay (ADR 0147 §5.2, docs/media/plan.md "D2 notes"): a relay
 * stream with the `media` purpose. Its hello is the relay channel's own, naming `channel: "media"`
 * and the `media.connect` ticket; the daemon checks it, answers `welcome` and hands the stream to
 * ace-media, which carries it from there under the same keys. A refusal (an `error` frame, or the
 * stream closing before the welcome) reaches the media connection as a close before `welcome`.
 */

export interface MediaRelayOptions {
  relayUrl: string;
  /** This app's `ace-client` name (ADR 0189), for the relay's upgrade. */
  aceClient?: AceClient | undefined;
  /** The daemon's relay host key, which its welcome must name. */
  pinnedFingerprint: string;
  deviceId: string;
  credential(): Promise<Credential>;
  socket: PortableRelayOptions["socket"];
  keys: PortableRelayOptions["keys"];
  schedule: PortableRelayOptions["schedule"];
  /** Injectable for tests; omitted, the portable relay client. */
  connect?(options: PortableRelayOptions): Promise<PortableRelay>;
}

/** Text the media connection sends (acks, pings) stays small. */
const textLimit = 64 * 1024;

/** Opens media connections as relay streams with the `media` purpose. */
export function relayMediaStreams(options: MediaRelayOptions): OpenMediaRelay {
  return (ticket, events) => {
    const controller = new AbortController();
    let relay: PortableRelay | undefined;
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      controller.abort();
      relay?.close();
      events.close(code);
    };
    void (async () => {
      const credential = await options.credential();
      const connect = options.connect ?? (await import("./portable-relay.ts")).connectPortableRelay;
      if (ended) return;
      const opened = await connect({
        relayUrl: options.relayUrl,
        pinnedFingerprint: options.pinnedFingerprint,
        aceClient: options.aceClient,
        purpose: "media",
        socket: options.socket,
        grant: relayGrant(credential),
        keys: options.keys,
        schedule: options.schedule,
        signal: controller.signal,
      });
      relay = opened;
      if (ended) return opened.close();
      await opened.send(
        ClientMessage.parse({
          type: "hello",
          protocolVersion: 1,
          deviceId: options.deviceId,
          ...(typeof credential === "string" ? { token: credential } : credential),
          channel: "media",
          mediaTicket: ticket,
          // The relay route returns credit as it reads, so the relay never holds a backlog.
          flowControl: ["credit"],
        }),
      );
      const first = await opened.receive();
      if (
        first instanceof Uint8Array ||
        first.type !== "welcome" ||
        first.hostId !== options.pinnedFingerprint
      )
        return end(mediaCloseCodes.refused);
      events.welcome();
      for (;;) {
        const data = await opened.receiveRaw();
        if (ended) return;
        events.message(data);
      }
    })().catch((error: unknown) =>
      end(error instanceof RelayClosedError ? error.code : ended ? 1000 : 1006),
    );
    return {
      send: (data) => {
        if (!relay || ended) throw new Error("Media relay stream isn't open");
        if (typeof data !== "string") throw new Error("A media relay stream sends text only");
        void relay.sendText(data, textLimit).catch(() => end(1006));
      },
      close: () => end(1000),
    };
  };
}
