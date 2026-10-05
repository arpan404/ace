/** Bounded Annex B reader for the emulator's hardware stream after ffmpeg inserts AUDs. */
export class H264AccessUnits {
  private nal = Buffer.allocUnsafe(4096);
  private length = 0;
  private zeros = 0;
  private started = false;
  private parts: Buffer[] = [];
  private bytes = 0;
  private key = false;
  private parameters = new Map<number, Buffer>();
  private codec = "avc1.42E01F";
  private readonly emit: (payload: Buffer, key: boolean, codec: string) => void;
  constructor(emit: (payload: Buffer, key: boolean, codec: string) => void) {
    this.emit = emit;
  }
  push(chunk: Buffer): void {
    for (const byte of chunk) {
      if (this.length === this.nal.length) {
        if (this.length >= 8 * 1024 * 1024) throw new Error("H.264 NAL exceeds limit");
        const next = Buffer.allocUnsafe(Math.min(8 * 1024 * 1024, this.nal.length * 2));
        this.nal.copy(next, 0, 0, this.length);
        this.nal = next;
      }
      this.nal[this.length++] = byte;
      if (byte === 1 && this.zeros >= 2) {
        const prefix = Math.min(3, this.zeros) + 1;
        if (this.started && this.length > prefix)
          this.unit(Buffer.from(this.nal.subarray(0, this.length - prefix)));
        this.started = true;
        this.length = 0;
        this.zeros = 0;
      } else this.zeros = byte === 0 ? this.zeros + 1 : 0;
    }
  }
  private unit(nal: Buffer): void {
    const type = (nal[0] ?? 0) & 31;
    if (type === 9) {
      this.flush();
      return;
    }
    const packet = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
    if (type === 7 || type === 8) {
      if (nal.length > 4096) throw new Error("H.264 parameter set exceeds limit");
      this.parameters.set(type, packet);
      if (type === 7 && nal.length >= 4) this.codec = "avc1." + nal.subarray(1, 4).toString("hex");
      return;
    }
    if (type === 5) this.key = true;
    this.bytes += packet.length;
    if (this.bytes > 8 * 1024 * 1024 || this.parts.length >= 1024)
      throw new Error("H.264 access unit exceeds limit");
    this.parts.push(packet);
  }
  private flush(): void {
    if (this.parts.length) {
      const parameters = this.key ? [...this.parameters.values()] : [];
      const payload = Buffer.concat([...parameters, ...this.parts]);
      if (payload.length > 8 * 1024 * 1024) throw new Error("H.264 access unit exceeds limit");
      this.emit(payload, this.key, this.codec);
    }
    this.parts = [];
    this.bytes = 0;
    this.key = false;
  }
  end(): void {
    if (this.started && this.length) this.unit(Buffer.from(this.nal.subarray(0, this.length)));
    this.flush();
  }
}
