import { ClientError } from "./errors.ts";
/** Pure retained UTF-16 byte admission; the connection owns absolute completion timers. */
export class FragmentPolicy {
  private entries = new Map<
    string,
    { seq: number; index: number; bytes: number; parts: string[] }
  >();
  private bytes = 0;
  private budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }
  add(key: string, seq: number, index: number, data: string, done: boolean): string | undefined {
    let entry = this.entries.get(key);
    if (index === 0) {
      if (entry) throw new ClientError("protocol", "Repeated fragment start");
      if (this.entries.size >= 4) throw new ClientError("limit", "Fragment source budget exceeded");
      entry = { seq, index: 0, bytes: 0, parts: [] };
      this.entries.set(key, entry);
    }
    if (!entry || entry.seq !== seq || entry.index !== index) throw new ClientError("protocol");
    const bytes = data.length * 2;
    if (this.bytes + bytes > this.budget)
      throw new ClientError("limit", "Fragment byte budget exceeded");
    entry.index++;
    entry.bytes += bytes;
    this.bytes += bytes;
    entry.parts.push(data);
    if (!done) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    return entry.parts.join("");
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
