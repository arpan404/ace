import type { FakeDaemon } from "@ace/fake-daemon";
import { drawPage, title } from "./spike-browser.ts";

/*
 * The subscribe's poster in the iOS spike fixture (ADR 0149). With `ACE_IOS_SPIKE_POSTER=1`, the
 * reply to each `browser.subscribe` carries `media.poster`, a JPEG of the drawn page at the
 * subscribed size, as ace-media's still path makes one. With `hold`, the page's live video is
 * also held back until `POST /poster`, so the poster alone is on screen until then.
 */

export interface SpikePoster {
  /** A message from the phone: notes each browser subscribe's request and size. */
  observe(text: string): void;
  /** A message to the phone: the subscribe's reply gains its poster. */
  rewrite(text: string): string;
  /**
   * The binary path to one phone: while held, its pieces wait (the fake daemon sends the next
   * frame only once this one is acknowledged, so nothing is lost) and go out on release.
   */
  gate(send: (bytes: Uint8Array) => void): (bytes: Uint8Array) => void;
  control(request: Request): Response | undefined;
}

/** A connection id for the fixture's posters: the phone keeps delivery on its main socket. */
const connection = "mc_fixtureposter";
/** The schema's bound on the poster's base64. */
const maxBase64 = 64 * 1024;

export function spikePoster(daemon: FakeDaemon, mode: string | undefined): SpikePoster {
  const enabled = mode === "1" || mode === "hold";
  let held = mode === "hold";
  const waiting = new Set<() => void>();
  const asked = new Map<string, { threadId: string; width: number; height: number }>();
  return {
    observe(text) {
      if (!enabled || !text.includes('"browser.subscribe"')) return;
      const message = JSON.parse(text) as {
        type?: string;
        requestId?: string;
        threadId?: string;
        viewport?: { width?: number; height?: number };
      };
      if (message.type !== "browser.subscribe" || !message.requestId || !message.threadId) return;
      asked.set(message.requestId, {
        threadId: message.threadId,
        width: Math.round(message.viewport?.width ?? 402),
        height: Math.round(message.viewport?.height ?? 640),
      });
    },
    rewrite(text) {
      if (!enabled || !text.includes('"browser.result"')) return text;
      const message = JSON.parse(text) as { requestId?: string; ok?: boolean };
      const subscribe = message.requestId ? asked.get(message.requestId) : undefined;
      if (!subscribe || message.ok !== true) return text;
      asked.delete(message.requestId ?? "");
      const jpeg = drawPage(
        subscribe.width,
        subscribe.height,
        "jpeg",
        title(daemon, subscribe.threadId),
      ).toString("base64");
      if (jpeg.length > maxBase64) throw new Error(`The fixture's poster is ${jpeg.length} bytes`);
      const poster = { width: subscribe.width * 2, height: subscribe.height * 2, jpeg };
      return JSON.stringify({ ...message, media: { connection, poster } });
    },
    gate(send) {
      const pieces: Uint8Array[] = [];
      const flush = () => {
        for (const piece of pieces.splice(0)) send(piece);
      };
      waiting.add(flush);
      return (bytes) => {
        if (held) pieces.push(bytes);
        else send(bytes);
      };
    },
    control(request) {
      if (new URL(request.url).pathname !== "/poster" || request.method !== "POST")
        return undefined;
      held = false;
      for (const flush of waiting) flush();
      return Response.json({ ok: true });
    },
  };
}
