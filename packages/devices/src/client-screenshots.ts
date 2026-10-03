import { ScreenFrameHeader } from "@ace/protocol";
import type { PortableFrame } from "@ace/screen/frames-client";

const sequence = (value: ScreenFrameHeader) => (value.version === 1 ? value.sequence : value.seq);

/** Screenshot pixels precede their request metadata on the wire. Keep only latest frames. */
export class PendingScreenshots {
  private readonly requests = new Map<string, string>();
  private readonly frames = new Map<string, PortableFrame>();
  begin(requestId: string, deviceId: string): void {
    if (this.requests.size >= 4) throw new Error("Pending screenshot limit");
    this.requests.set(requestId, deviceId);
  }
  retain(frame: PortableFrame): void {
    if (!this.requests.size) return;
    const sessionId = frame.header.sessionId;
    this.frames.delete(sessionId);
    this.frames.set(sessionId, frame);
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
    const frame = this.frames.get(header.sessionId);
    this.frames.delete(header.sessionId);
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
