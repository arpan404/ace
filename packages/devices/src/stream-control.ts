import type { ScreenStreamSettings } from "@ace/protocol";
import { DeviceError } from "./sdk.ts";
import { deviceFrameRate } from "./stream-profile.ts";
import { recordingImages } from "./recording-feed.ts";
import { commonStream, sameStream, StreamOwners } from "@ace/screen";

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
 * (`DeviceCapture.still`) and streams nothing in between. The budget sizes each still.
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
  return profiles.length ? commonStream(profiles) : deviceImageStream;
}
export const sameDeviceStream = sameStream;

/**
 * Coalesce reconfiguration while a native update is outstanding. No queue of old sizes. While
 * anyone watches, the capture streams H.264 at the viewers' common budget, recording or not
 * (a recording decodes that video itself); a capture that can't is refused, never downgraded.
 * The owners' arbitration is the shared `StreamOwners` (`@ace/screen`); this adds the device's
 * rules: live views are H.264 only, and a recording's images while nobody watches.
 */
export class DeviceStreamControl {
  readonly #owners: StreamOwners;
  #recordings = 0;
  #closed = false;
  constructor(
    apply: (settings: ScreenStreamSettings) => Promise<{ codec: "jpeg" | "h264" }>,
    idle: () => ScreenStreamSettings = () => deviceImageStream,
  ) {
    this.#owners = new StreamOwners({
      apply,
      idle: () => (this.#recordings ? { ...deviceImageStream, ...recordingImages } : idle()),
      check: (next, result) => {
        if (next.codec === "h264" && result.codec !== "h264")
          throw new DeviceError(
            "not_supported",
            "This device's capture can't stream video for a live view",
            "Live views are H.264 only. Restart the device's live view; if it persists, check its capture tools.",
          );
      },
    });
  }
  has(owner: string): boolean {
    return this.#owners.has(owner);
  }
  set(owner: string, settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    if (this.#closed) return Promise.reject(new Error("Stream closed"));
    let request: ScreenStreamSettings;
    try {
      request = liveViewRequest(settings);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#owners.set(owner, request);
  }
  remove(owner: string): Promise<{ codec: "jpeg" | "h264" }> {
    if (this.#closed || !this.#owners.has(owner)) return Promise.resolve({ codec: "jpeg" });
    return this.#owners.remove(owner);
  }
  refresh(): Promise<{ codec: "jpeg" | "h264" }> {
    return this.#owners.refresh();
  }
  acquireRecording(): { ready: Promise<{ codec: "jpeg" | "h264" }>; release(): Promise<void> } {
    if (this.#closed) throw new Error("Stream closed");
    this.#recordings++;
    let released = false;
    return {
      ready: this.refresh(),
      release: async () => {
        if (released) return;
        released = true;
        this.#recordings--;
        if (!this.#closed) await this.refresh();
      },
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#owners.close();
  }
}
