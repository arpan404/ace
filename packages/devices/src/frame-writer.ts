/** Serialize whole packets, not relay fragments, so device streams cannot interleave. */
export class DeviceFrameWriter {
  private tail = Promise.resolve();
  private pending = 0;
  private closed = false;
  private readonly write: (packet: Buffer) => Promise<void>;
  constructor(write: (packet: Buffer) => Promise<void>) {
    this.write = write;
  }
  send(packet: Buffer, authorize: () => void = () => {}, write = this.write): Promise<void> {
    if (this.closed || this.pending >= 8)
      return Promise.reject(new Error("Device frame writer unavailable or full"));
    this.pending++;
    const task = this.tail
      .then(async () => {
        if (this.closed) throw new Error("Device frame writer closed");
        authorize();
        await write(packet);
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = task.catch(() => {});
    return task;
  }
  close(): void {
    this.closed = true;
  }
}
