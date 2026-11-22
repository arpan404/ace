import { createHash, type Hash } from "node:crypto";

/*
 * The turn's last answer as it streamed: its length and a running digest, never its text, so
 * a recovered saved answer of any size (up to recovery's 4 MiB cut) is matched against what ace
 * showed without holding that text again. Hashed as UTF-16 code units, so a delta that ends
 * mid surrogate pair hashes as the whole text does.
 */
export class StreamedAnswer {
  private length = 0;
  private hash: Hash = createHash("sha256");
  reset(): void {
    this.length = 0;
    this.hash = createHash("sha256");
  }
  add(text: string): void {
    this.length += text.length;
    this.hash.update(text, "utf16le");
  }
  /**
   * What of `result` was never shown: the rest of it when what streamed is its start, all of it
   * (`apart`) when what streamed differs, nothing when it is all shown. A saved answer recovery
   * cut (`cut`) that ace streamed past has nothing more to add.
   */
  missing(result: string, cut: boolean): { text: string; apart: boolean } | undefined {
    if (this.length > result.length) return cut ? undefined : { text: result, apart: true };
    const streamed = this.hash.copy().digest("hex");
    const head = createHash("sha256").update(result.slice(0, this.length), "utf16le").digest("hex");
    if (head !== streamed) return { text: result, apart: true };
    return this.length === result.length
      ? undefined
      : { text: result.slice(this.length), apart: false };
  }
}
