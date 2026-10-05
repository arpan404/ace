import type { ScreenStreamSettings } from "@ace/protocol";
export const deviceImageStream: ScreenStreamSettings = {
  codec: "jpeg",
  maxWidth: 1920,
  maxHeight: 2160,
  fps: 30,
  bitrate: 4000000,
};
/** All viewers must be able to decode the shared capture; the slowest panel sets its budget. */
export function commonDeviceStream(
  profiles: readonly ScreenStreamSettings[],
): ScreenStreamSettings {
  if (!profiles.length) return deviceImageStream;
  return {
    codec: profiles.every((p) => p.codec === "h264") ? "h264" : "jpeg",
    maxWidth: Math.min(...profiles.map((p) => p.maxWidth)),
    maxHeight: Math.min(...profiles.map((p) => p.maxHeight)),
    fps: Math.min(...profiles.map((p) => p.fps)),
    bitrate: Math.min(...profiles.map((p) => p.bitrate)),
  };
}
/** Coalesce reconfiguration while a native update is outstanding. No queue of old sizes. */
export class DeviceStreamControl {
  private readonly viewers = new Map<string, ScreenStreamSettings>();
  private readonly apply: (settings: ScreenStreamSettings) => Promise<{ codec: "jpeg" | "h264" }>;
  private revision = 0;
  private applied = -1;
  private running: Promise<{ codec: "jpeg" | "h264" }> | undefined;
  private closed = false;
  private images = 0;
  constructor(apply: (settings: ScreenStreamSettings) => Promise<{ codec: "jpeg" | "h264" }>) {
    this.apply = apply;
  }
  has(owner: string): boolean {
    return this.viewers.has(owner);
  }
  set(owner: string, settings: ScreenStreamSettings) {
    if (this.closed) throw new Error("Stream closed");
    if (!this.viewers.has(owner) && this.viewers.size >= 64) throw new Error("Stream viewer limit");
    this.viewers.set(owner, settings);
    return this.refresh();
  }
  remove(owner: string): Promise<{ codec: "jpeg" | "h264" }> {
    if (this.closed || !this.viewers.delete(owner)) return Promise.resolve({ codec: "jpeg" });
    return this.refresh();
  }
  refresh(): Promise<{ codec: "jpeg" | "h264" }> {
    this.revision++;
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  acquireImage(): { ready: Promise<{ codec: "jpeg" | "h264" }>; release(): Promise<void> } {
    if (this.closed) throw new Error("Stream closed");
    this.images++;
    let released = false;
    return {
      ready: this.refresh(),
      release: async () => {
        if (released) return;
        released = true;
        this.images--;
        if (!this.closed) await this.refresh();
      },
    };
  }
  private async drain(): Promise<{ codec: "jpeg" | "h264" }> {
    let result: { codec: "jpeg" | "h264" } = { codec: "jpeg" };
    while (!this.closed && this.applied !== this.revision) {
      const revision = this.revision;
      const settings = commonDeviceStream([...this.viewers.values()]);
      result = await this.apply(this.images ? { ...settings, codec: "jpeg" } : settings);
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
