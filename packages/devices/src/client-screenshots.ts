import { ScreenFrameHeader } from "@ace/protocol";
import type { PortableFrame } from "@ace/screen/frames-client";

const key = (header: ScreenFrameHeader) => JSON.stringify([header.sessionId, sequence(header)]);
const sequence = (value: ScreenFrameHeader) => (value.version === 1 ? value.sequence : value.seq);

/** Keep at most four matching JPEG candidates until all screenshot metadata arrives. */
export class PendingScreenshots {
  private readonly requests = new Map<string, string>();
  private readonly frames = new Map<string, PortableFrame>();
  begin(requestId: string, deviceId: string): void {
    if (this.requests.size >= 4) throw new Error("Pending screenshot limit");
    this.requests.set(requestId, deviceId);
  }
  retain(frame: PortableFrame): void {
    if (!this.requests.size || frame.header.codec !== "jpeg") return;
    const identity = key(frame.header);
    this.frames.delete(identity);
    this.frames.set(identity, frame);
    if (this.frames.size > 4) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
  }
  complete(
    requestId: string,
    raw: unknown,
  ): { deviceId: string; frame: PortableFrame } | undefined {
    const deviceId = this.requests.get(requestId);
    const header = ScreenFrameHeader.parse(raw);
    const frame = this.frames.get(key(header));
    this.cancel(requestId);
    if (!deviceId || !frame) return undefined;
    if (sequence(header) !== sequence(frame.header) || header.bytes !== frame.header.bytes)
      return undefined;
    return { deviceId, frame };
  }
  cancel(requestId: string): void {
    this.requests.delete(requestId);
    if (!this.requests.size) this.frames.clear();
  }
  clear(): void {
    this.requests.clear();
    this.frames.clear();
  }
}
