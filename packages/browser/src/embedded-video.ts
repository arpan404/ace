import { z } from "zod";
import { BrowserVideoCodec } from "@ace/protocol";
import type { BrowserCdp, CaptureEvents, VideoCaptureHandle, VideoHost } from "./backend.ts";
import { decodeEmbeddedVideo } from "./embedded-video-wire.ts";
import { deliverVideoEvent, VideoEncoderEvent } from "./video-events.ts";

/*
 * The desktop app as a video encoder (ADR 0088, embedded backend): the desktop captures a view
 * and encodes it with the same code as ace's Chrome (`video-extension/offscreen.ts`), in a
 * hidden page of its own. The daemon drives it with `ace.video.*` commands on the tab's own
 * relayed CDP, so each command reaches the view it names, and receives its events as binary
 * messages on the backend socket (`embedded-video-wire.ts`). One per desktop backend.
 */

const Supported = z.object({ codecs: z.array(BrowserVideoCodec) });

export class EmbeddedVideo {
  private prefix: string;
  private captures = new Map<string, CaptureEvents>();
  private ids = 0;
  /** `prefix` keeps capture ids apart from another backend's (a reconnected desktop). */
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  /** The encoder as one page sees it: codec support is asked of that page's desktop. */
  host(page: BrowserCdp): VideoHost {
    return {
      supported: async (codecs, width, height) =>
        Supported.parse(
          await page.send("ace.video.supported", { codecs: [...codecs], width, height }),
        ).codecs,
      open: (target, width, height, events) => this.open(target, width, height, events),
    };
  }
  private async open(
    page: BrowserCdp,
    width: number,
    height: number,
    events: CaptureEvents,
  ): Promise<VideoCaptureHandle> {
    const id = `${this.prefix}-${++this.ids}`;
    // Listening before the start: its first chunks may arrive before the reply.
    this.captures.set(id, events);
    try {
      await page.send("ace.video.start", { capture: id, width, height });
    } catch (error) {
      this.captures.delete(id);
      throw error;
    }
    const call = (method: string, params: Record<string, unknown>) =>
      void page.send(method, { capture: id, ...params }).catch(() => {});
    return {
      encodes: (specs) => call("ace.video.encodes", { encodes: specs }),
      keyframe: (encode) => call("ace.video.keyframe", { encode }),
      audio: (on) => call("ace.video.audio", { on }),
      close: () => {
        if (!this.captures.delete(id)) return;
        call("ace.video.stop", {});
      },
    };
  }
  /** A binary message from the desktop; false when it is not an encoder event. */
  receive(frame: Uint8Array): boolean {
    const decoded = decodeEmbeddedVideo(frame);
    if (!decoded) return false;
    const event = VideoEncoderEvent.safeParse(decoded.header);
    if (event.success) deliverVideoEvent(this.captures, event.data, decoded.bytes);
    return true;
  }
  /** The desktop is gone: every capture has ended. */
  endAll(): void {
    const ended = [...this.captures.values()];
    this.captures.clear();
    for (const events of ended) events.ended();
  }
}
