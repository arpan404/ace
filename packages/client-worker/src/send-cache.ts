import { ClientError, type PendingSend } from "@ace/client";

const active = (entry: PendingSend) => entry.state === "saving" || entry.state === "sent";
/** Bounded tab drafts. Active sends are protected; settled entries are a replaceable cache. */
export class SendCache {
  private entries = new Map<string, PendingSend>();
  private sizes = new Map<string, number>();
  private bytes = 0;
  private settled = 0;
  private limit: number;
  private byteLimit: number;
  private settledLimit: number;
  constructor(limit: number, byteLimit: number, settledLimit: number) {
    this.limit = limit;
    this.byteLimit = byteLimit;
    this.settledLimit = settledLimit;
  }
  get(id: string): PendingSend | undefined {
    return this.entries.get(id);
  }
  keys(): MapIterator<string> {
    return this.entries.keys();
  }
  values(): MapIterator<PendingSend> {
    return this.entries.values();
  }
  set(id: string, entry: PendingSend): void {
    const previous = this.entries.get(id);
    this.delete(id);
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    this.entries.set(id, entry);
    this.sizes.set(id, size);
    this.bytes += size;
    if (!active(entry)) this.settled++;
    this.trim(id);
    if (this.entries.size > this.limit || this.bytes > this.byteLimit) {
      this.delete(id);
      if (previous) this.set(id, previous);
      throw new ClientError("limit");
    }
    if (this.settled > this.settledLimit && !active(entry)) this.delete(id);
  }
  delete(id: string): void {
    const previous = this.entries.get(id);
    if (!previous) return;
    if (!active(previous)) this.settled--;
    this.bytes -= this.sizes.get(id) ?? 0;
    this.sizes.delete(id);
    this.entries.delete(id);
  }
  retainSettled(limit: number): void {
    this.settledLimit = limit;
    this.trim();
  }
  private trim(protect?: string): void {
    if (this.fits()) return;
    for (const [id, entry] of this.entries) {
      if (id === protect || active(entry)) continue;
      this.delete(id);
      if (this.fits()) break;
    }
  }
  private fits(): boolean {
    return (
      this.entries.size <= this.limit &&
      this.bytes <= this.byteLimit &&
      this.settled <= this.settledLimit
    );
  }
}
