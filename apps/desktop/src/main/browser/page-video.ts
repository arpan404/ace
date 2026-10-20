import { z } from "zod";

/*
 * One view's video captures (ADR 0088, embedded backend). The daemon drives them with
 * `ace.video.*` commands on the view's own CDP relay; this checks each command and hands it to
 * the app's encoder (`video-encoder.ts`), and knows whether the view is being captured, which
 * keeps it rendering at full rate while nobody sees it (`throttle.ts`).
 */

/** Where the app's hidden encoder page lives (`video-encoder.ts`); no web page has it. */
export const encoderOrigin = "app://video-encoder";

/**
 * The encoder capturing a view. Electron asks the captured view's own session for this
 * permission (as `media`, from the encoder's origin), not the encoder's: the views' sessions,
 * which refuse every permission, let this one through.
 */
export function encoderCapture(permission: string, origin: string | undefined): boolean {
  if (permission !== "media" || !origin) return false;
  return origin === encoderOrigin || origin === `${encoderOrigin}/`;
}

/** The app's video encoder, as one view uses it. `Source` is the view's page to capture. */
export interface PageVideoHost<Source> {
  supported(codecs: readonly string[], width: number, height: number): Promise<string[]>;
  start(capture: string, source: Source, width: number, height: number): Promise<void>;
  encodes(capture: string, encodes: readonly EncodeSpec[]): void;
  keyframe(capture: string, encode: string): void;
  audio(capture: string, on: boolean): void;
  stop(capture: string): void;
  /** A capture stopped, whatever the reason (asked to, its page went away, the encoder died). */
  onStopped(listener: (capture: string) => void): () => void;
}

const id = z.string().min(1).max(256);
/** Encode sizes as the daemon's policy caps them (2560 px on the long side), with room. */
const size = z.number().int().min(2).max(8192);
const EncodeSpec = z.object({
  key: id,
  codec: z.string().min(1).max(64),
  width: size,
  height: size,
  fps: z.number().min(1).max(120),
  bitrate: z.number().int().min(1).max(100_000_000),
});
export type EncodeSpec = z.infer<typeof EncodeSpec>;
const Supported = z.object({
  codecs: z.array(z.string().max(64)).max(16),
  width: size,
  height: size,
});
const Start = z.object({ capture: id, width: size, height: size });
const Encodes = z.object({ capture: id, encodes: z.array(EncodeSpec).max(8) });
const Keyframe = z.object({ capture: id, encode: id });
const Audio = z.object({ capture: id, on: z.boolean() });
const Stop = z.object({ capture: id });

export class PageVideo<Source> {
  private host: PageVideoHost<Source>;
  private source: Source;
  private changed: () => void;
  private captures = new Set<string>();
  private stopListening: () => void;
  constructor(host: PageVideoHost<Source>, source: Source, changed: () => void) {
    this.host = host;
    this.source = source;
    this.changed = changed;
    this.stopListening = host.onStopped((capture) => {
      if (this.captures.delete(capture)) this.changed();
    });
  }

  /** The view is being captured: it must keep rendering, seen or not. */
  capturing(): boolean {
    return this.captures.size > 0;
  }

  /** Runs an `ace.video.*` command; undefined for any other method. */
  command(method: string, params: unknown): Promise<unknown> | undefined {
    if (!method.startsWith("ace.video.")) return undefined;
    return this.run(method, params);
  }

  private async run(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "ace.video.supported": {
        const { codecs, width, height } = Supported.parse(params);
        return { codecs: await this.host.supported(codecs, width, height) };
      }
      case "ace.video.start": {
        const { capture, width, height } = Start.parse(params);
        // Counted from now: the view renders while the capture starts.
        this.captures.add(capture);
        this.changed();
        try {
          await this.host.start(capture, this.source, width, height);
        } catch (error) {
          if (this.captures.delete(capture)) this.changed();
          throw error;
        }
        return {};
      }
      case "ace.video.encodes": {
        const { capture, encodes } = Encodes.parse(params);
        if (this.captures.has(capture)) this.host.encodes(capture, encodes);
        return {};
      }
      case "ace.video.keyframe": {
        const { capture, encode } = Keyframe.parse(params);
        if (this.captures.has(capture)) this.host.keyframe(capture, encode);
        return {};
      }
      case "ace.video.audio": {
        const { capture, on } = Audio.parse(params);
        if (this.captures.has(capture)) this.host.audio(capture, on);
        return {};
      }
      case "ace.video.stop": {
        const { capture } = Stop.parse(params);
        if (this.captures.has(capture)) this.host.stop(capture);
        return {};
      }
    }
    throw new Error(`Unknown video command ${method}`);
  }

  /** The view closes: its captures stop. */
  close(): void {
    this.stopListening();
    const captures = [...this.captures];
    this.captures.clear();
    for (const capture of captures) this.host.stop(capture);
  }
}
