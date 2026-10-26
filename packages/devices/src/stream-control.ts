import type { ScreenStreamSettings } from "@ace/protocol";
import { DeviceError } from "./sdk.ts";
import { deviceFrameRate } from "./stream-profile.ts";
import { recordingImages } from "./recording-feed.ts";

/**
 * A capture nobody is watching: agents' stills and recordings read its JPEG frames. No live view
 * ever receives one; a view's arrival switches the capture to H.264.
 */
export const deviceImageStream: ScreenStreamSettings = {
  codec: "jpeg",
  maxWidth: 1920,
  maxHeight: 2160,
  fps: 30,
  bitrate: 4000000,
};
/**
 * A capture nobody watches or records, which makes a fresh still whenever an agent asks for one
 * (`DeviceCapture.still`): a slow heartbeat instead of a still for every change of the screen.
 */
export const deviceStillStream: ScreenStreamSettings = { ...deviceImageStream, fps: 2 };
/** A live view that hasn't sized its stream yet: H.264 at 60 fps in a phone-sized box. */
export const deviceVideoStream: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 1440,
  maxHeight: 2880,
  fps: deviceFrameRate,
  bitrate: 8000000,
};

/** A live view only takes video; a client asking for JPEG is out of date. */
export function liveViewRequest(settings: ScreenStreamSettings): ScreenStreamSettings {
  if (settings.codec !== "h264")
    throw new DeviceError(
      "not_supported",
      "Device live views are H.264 video only",
      "Update ace on this device; live views no longer stream JPEG.",
    );
  return settings;
}
/** Every viewer decodes the shared capture's H.264; the slowest panel sets its budget. */
export function commonDeviceStream(
  profiles: readonly ScreenStreamSettings[],
): ScreenStreamSettings {
  if (!profiles.length) return deviceImageStream;
  return {
    codec: "h264",
    maxWidth: Math.min(...profiles.map((p) => p.maxWidth)),
    maxHeight: Math.min(...profiles.map((p) => p.maxHeight)),
    fps: Math.min(...profiles.map((p) => p.fps)),
    bitrate: Math.min(...profiles.map((p) => p.bitrate)),
  };
}
export function sameDeviceStream(a: ScreenStreamSettings, b: ScreenStreamSettings): boolean {
  return (
    a.codec === b.codec &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.fps === b.fps &&
    a.bitrate === b.bitrate
  );
}

/**
 * Coalesce reconfiguration while a native update is outstanding. No queue of old sizes. While
 * anyone watches, the capture streams H.264 at the viewers' common budget, recording or not
 * (a recording decodes that video itself); a capture that can't is refused, never downgraded.
 */
export class DeviceStreamControl {
  private readonly viewers = new Map<string, ScreenStreamSettings>();
  private readonly apply: (settings: ScreenStreamSettings) => Promise<{ codec: "jpeg" | "h264" }>;
  /** What the capture streams while nobody watches or records. */
  private readonly idle: () => ScreenStreamSettings;
  private revision = 0;
  private applied = -1;
  private settings: ScreenStreamSettings | undefined;
  private result: { codec: "jpeg" | "h264" } = { codec: "jpeg" };
  private running: Promise<{ codec: "jpeg" | "h264" }> | undefined;
  private closed = false;
  private recordings = 0;
  constructor(
    apply: (settings: ScreenStreamSettings) => Promise<{ codec: "jpeg" | "h264" }>,
    idle: () => ScreenStreamSettings = () => deviceImageStream,
  ) {
    this.apply = apply;
    this.idle = idle;
  }
  has(owner: string): boolean {
    return this.viewers.has(owner);
  }
  async set(owner: string, settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    if (this.closed) throw new Error("Stream closed");
    if (!this.viewers.has(owner) && this.viewers.size >= 64) throw new Error("Stream viewer limit");
    this.viewers.set(owner, liveViewRequest(settings));
    return this.refresh();
  }
  remove(owner: string): Promise<{ codec: "jpeg" | "h264" }> {
    if (this.closed || !this.viewers.delete(owner)) return Promise.resolve({ codec: "jpeg" });
    return this.refresh();
  }
  async refresh(): Promise<{ codec: "jpeg" | "h264" }> {
    this.revision++;
    // A no-op drain may already have settled when another update joins it.
    do {
      this.running ??= this.drain().finally(() => {
        this.running = undefined;
      });
      await this.running;
    } while (!this.closed && this.applied !== this.revision);
    return this.result;
  }
  acquireRecording(): { ready: Promise<{ codec: "jpeg" | "h264" }>; release(): Promise<void> } {
    if (this.closed) throw new Error("Stream closed");
    this.recordings++;
    let released = false;
    return {
      ready: this.refresh(),
      release: async () => {
        if (released) return;
        released = true;
        this.recordings--;
        if (!this.closed) await this.refresh();
      },
    };
  }
  private async drain(): Promise<{ codec: "jpeg" | "h264" }> {
    let result = this.result;
    while (!this.closed && this.applied !== this.revision) {
      const revision = this.revision;
      const next = this.viewers.size
        ? commonDeviceStream([...this.viewers.values()])
        : this.recordings
          ? { ...deviceImageStream, ...recordingImages }
          : this.idle();
      if (!this.settings || !sameDeviceStream(this.settings, next)) {
        // A refused update may have half-applied: the next one always reaches the capture.
        this.settings = undefined;
        result = await this.apply(next);
        if (next.codec === "h264" && result.codec !== "h264")
          throw new DeviceError(
            "not_supported",
            "This device's capture can't stream video for a live view",
            "Live views are H.264 only. Restart the device's live view; if it persists, check its capture tools.",
          );
        this.settings = { ...next };
        this.result = result;
      }
      this.applied = revision;
    }
    return result;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.viewers.clear();
    await this.running;
  }
}
