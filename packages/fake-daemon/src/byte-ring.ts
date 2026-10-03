/** Browser-safe bounded byte ring. Writes copy only changed bytes. */
export class FakeByteRing {
  private bytes: Uint8Array;
  start = 0;
  end = 0;
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_048_576)
      throw new Error("Invalid ring capacity");
    this.bytes = new Uint8Array(capacity);
  }
  append(data: Uint8Array): void {
    const end = this.end + data.length;
    const retained = data.subarray(Math.max(0, data.length - this.bytes.length));
    const offset = (end - retained.length) % this.bytes.length;
    const first = Math.min(retained.length, this.bytes.length - offset);
    this.bytes.set(retained.subarray(0, first), offset);
    this.bytes.set(retained.subarray(first), 0);
    this.end = end;
    this.start = Math.max(0, end - this.bytes.length);
  }
  align(offset: number): number {
    let value = Math.max(this.start, offset);
    while (
      value < this.end &&
      (this.bytes[value % this.bytes.length] ?? 0) >= 0x80 &&
      (this.bytes[value % this.bytes.length] ?? 0) < 0xc0
    )
      value++;
    return value;
  }
  read(offset: number, limit = 65536): string {
    const start = this.align(offset);
    let end = Math.min(this.end, start + limit);
    if (end < this.end)
      while (
        end > start &&
        (this.bytes[end % this.bytes.length] ?? 0) >= 0x80 &&
        (this.bytes[end % this.bytes.length] ?? 0) < 0xc0
      )
        end--;
    const result = new Uint8Array(end - start);
    const index = start % this.bytes.length;
    const first = Math.min(result.length, this.bytes.length - index);
    result.set(this.bytes.subarray(index, index + first));
    result.set(this.bytes.subarray(0, result.length - first), first);
    return new TextDecoder().decode(result);
  }
}
