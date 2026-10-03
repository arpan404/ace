/** Raw output kept per terminal for a renderer mounting late; about the screen's scrollback. */
const defaultLimit = 1_000_000;

/**
 * The most recent output chunks of a terminal, at most `limit` characters (the oldest whole
 * chunks go first; one chunk longer than the limit is kept alone). Appending and dropping cost
 * the chunk, never the whole log.
 */
export class RawLog {
  private chunks: string[] = [];
  private head = 0;
  private size = 0;
  private limit: number;
  constructor(limit = defaultLimit) {
    this.limit = limit;
  }
  /** Characters held. */
  get length(): number {
    return this.size;
  }
  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.limit && this.chunks.length - this.head > 1)
      this.size -= this.chunks[this.head++]?.length ?? 0;
    // Drop the consumed prefix now and then rather than shifting on every chunk.
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
  text(): string {
    return this.chunks.slice(this.head).join("");
  }
  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.size = 0;
  }
}
