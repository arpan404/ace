/**
 * Serialize whole messages, not relay fragments, so device streams cannot interleave: a screen
 * packet's fragments and a media picture's stream pieces always go out back to back.
 */
export class DeviceFrameWriter {
  private tail = Promise.resolve();
  private queued = 0;
  private closed = false;
  private readonly write: (packet: Buffer) => Promise<void>;
  constructor(write: (packet: Buffer) => Promise<void>) {
    this.write = write;
  }
  /** Messages queued or being written. */
  get pending(): number {
    return this.queued;
  }
  send(packet: Buffer, authorize: () => void = () => {}, write = this.write): Promise<void> {
    return this.run(() => write(packet), authorize);
  }
  /** One whole message's writes, in order with every other message. */
  run(task: () => Promise<void>, authorize: () => void = () => {}): Promise<void> {
    if (this.closed || this.queued >= 8)
      return Promise.reject(new Error("Device frame writer unavailable or full"));
    this.queued++;
    const next = this.tail
      .then(async () => {
        if (this.closed) throw new Error("Device frame writer closed");
        authorize();
        await task();
      })
      .finally(() => {
        this.queued--;
      });
    this.tail = next.catch(() => {});
    return next;
  }
  close(): void {
    this.closed = true;
  }
}
