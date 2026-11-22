import { createHash, type Hash } from "node:crypto";

/*
 * The turn's last answer as it streamed: its length and digests, never its text, so a
 * recovered saved answer of any size (up to recovery's 4 MiB cut) is matched against what ace
 * showed without holding that text again. Hashed as UTF-16 code units, so a delta that ends mid
 * surrogate pair hashes as the whole text does. Besides the running digest, the digest of every
 * whole `step` code units is kept (about 32 bytes per 4,096 units), so a saved answer shorter
 * than what streamed is still checked against it, to the last step inside it.
 */
const step = 4096;
const hex = (text: string) => createHash("sha256").update(text, "utf16le").digest("hex");

export class StreamedAnswer {
  private length = 0;
  private hash: Hash = createHash("sha256");
  /** The digest of the first `(index + 1) * step` code units. */
  private steps: string[] = [];
  reset(): void {
    this.length = 0;
    this.hash = createHash("sha256");
    this.steps = [];
  }
  add(text: string): void {
    let at = 0;
    while (at < text.length) {
      const room = step - (this.length % step);
      const piece = text.slice(at, at + room);
      this.hash.update(piece, "utf16le");
      this.length += piece.length;
      at += piece.length;
      if (this.length % step === 0) this.steps.push(this.hash.copy().digest("hex"));
    }
  }
  /**
   * What of `result` was never shown: the rest of it when what streamed is its start, all of it
   * (`apart`) when what streamed differs, nothing when it is all shown. A saved answer recovery
   * cut (`cut`) that is the start of what streamed has nothing more to add.
   */
  missing(result: string, cut: boolean): { text: string; apart: boolean } | undefined {
    if (this.length > result.length) {
      // The overlap is compared first, to the last whole step inside the saved answer.
      const whole = Math.floor(result.length / step);
      const same = whole > 0 && this.steps[whole - 1] === hex(result.slice(0, whole * step));
      return cut && same ? undefined : { text: result, apart: true };
    }
    if (hex(result.slice(0, this.length)) !== this.hash.copy().digest("hex"))
      return { text: result, apart: true };
    return this.length === result.length
      ? undefined
      : { text: result.slice(this.length), apart: false };
  }
}
