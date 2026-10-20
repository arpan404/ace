import { DeviceScreenshot } from "@ace/protocol/devices";
import type { SourcePicture } from "@ace/browser/live-view";

const key = (deviceId: string, streamId: string, sequence: number) =>
  JSON.stringify([deviceId, streamId, sequence]);

/**
 * Screenshots in flight: the daemon sends each one's still picture on the media stream just
 * before the result that names it. At most four requests, and four candidate stills, wait.
 */
export class PendingScreenshots {
  private readonly requests = new Map<string, string>();
  private readonly stills = new Map<string, SourcePicture>();
  begin(requestId: string, deviceId: string): void {
    if (this.requests.size >= 4) throw new Error("Pending screenshot limit");
    this.requests.set(requestId, deviceId);
  }
  retain(picture: SourcePicture): void {
    if (!this.requests.size || !picture.still) return;
    const identity = key(picture.sourceId, picture.streamId, picture.sequence);
    this.stills.delete(identity);
    this.stills.set(identity, picture);
    if (this.stills.size > 4) {
      const oldest = this.stills.keys().next().value;
      if (oldest !== undefined) this.stills.delete(oldest);
    }
  }
  /** The still a result names, or undefined when it never came or doesn't match. */
  complete(requestId: string, raw: unknown): SourcePicture | undefined {
    const deviceId = this.requests.get(requestId);
    const result = DeviceScreenshot.parse(raw);
    const picture =
      deviceId === undefined
        ? undefined
        : this.stills.get(key(deviceId, result.streamId, result.sequence));
    this.cancel(requestId);
    if (!picture || picture.bytes.length !== result.bytes) return undefined;
    return picture;
  }
  cancel(requestId: string): void {
    this.requests.delete(requestId);
    if (!this.requests.size) this.stills.clear();
  }
  clear(): void {
    this.requests.clear();
    this.stills.clear();
  }
}
