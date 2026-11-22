import { createHash, type Hash } from "node:crypto";

/*
 * The turn's last answer as it streamed: its length and digests, never its text, so a
 * recovered saved answer is matched against what ace showed without holding that text again.
 * Hashed as UTF-16 code units, so a delta that ends mid surrogate pair hashes as the whole text
 * does.
 *
 * Besides the digest of all of it, one more is kept: of exactly the start of it that fits in
 * 4 MiB of UTF-8, between whole characters, which is where recovery cuts a saved answer
 * (`resultParts` in recovery.ts, as TextEncoder.encodeInto counts: a lone surrogate takes 3
 * bytes). A cut saved answer is the start of what streamed only if it is exactly that, so the
 * check is exact at any length. What streamed past 4 MiB can't be compared with a saved answer
 * cut there and isn't: such an answer counts as shown when it is that start.
 */
const cap = 4 * 1024 * 1024;
const hex = (text: string) => createHash("sha256").update(text, "utf16le").digest("hex");
const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const width = (code: number) => (code < 0x80 ? 1 : code < 0x800 ? 2 : 3);

export class StreamedAnswer {
  private length = 0;
  private hash: Hash = createHash("sha256");
  /** The start that fits in 4 MiB of UTF-8: its digest so far, units and bytes. */
  private capped: Hash = createHash("sha256");
  private cappedUnits = 0;
  private cappedBytes = 0;
  /** Set once a character didn't fit: nothing more goes into `capped`. */
  private full = false;
  /** A high surrogate that ended the last delta: its width depends on what comes next. */
  private held = "";
  reset(): void {
    this.length = 0;
    this.hash = createHash("sha256");
    this.capped = createHash("sha256");
    this.cappedUnits = 0;
    this.cappedBytes = 0;
    this.full = false;
    this.held = "";
  }
  add(text: string): void {
    this.length += text.length;
    this.hash.update(text, "utf16le");
    if (!this.full) this.fit(text);
  }
  /** Takes in what of `text` still fits in 4 MiB, a whole character at a time. */
  private fit(text: string): void {
    let at = 0;
    // A high surrogate that ended the last delta pairs with a low one starting this one.
    if (this.held) {
      const pairs = text.length > 0 && low(text.charCodeAt(0));
      if (!pairs && text.length === 0) return;
      if (!this.take(this.held + (pairs ? text[0] : ""), pairs ? 4 : 3)) return;
      this.held = "";
      at = pairs ? 1 : 0;
    }
    const from = at;
    let bytes = this.cappedBytes;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (high(code) && at + 1 === text.length) break;
      const pair = high(code) && low(text.charCodeAt(at + 1));
      const size = pair ? 4 : width(code);
      if (bytes + size > cap) {
        this.full = true;
        break;
      }
      bytes += size;
      at += pair ? 2 : 1;
    }
    this.capped.update(text.slice(from, at), "utf16le");
    this.cappedUnits += at - from;
    this.cappedBytes = bytes;
    if (!this.full && at < text.length) this.held = text.slice(at);
  }
  /** Takes in one character of `size` bytes if it fits; false once it doesn't. */
  private take(char: string, size: number): boolean {
    if (this.cappedBytes + size > cap) {
      this.full = true;
      return false;
    }
    this.capped.update(char, "utf16le");
    this.cappedUnits += char.length;
    this.cappedBytes += size;
    return true;
  }
  /** The start that fits in 4 MiB, a held high surrogate counted as the lone one it is. */
  private cut(): { units: number; digest: string } {
    const digest = this.capped.copy();
    if (this.held && !this.full && this.cappedBytes + 3 <= cap) {
      digest.update(this.held, "utf16le");
      return { units: this.cappedUnits + this.held.length, digest: digest.digest("hex") };
    }
    return { units: this.cappedUnits, digest: digest.digest("hex") };
  }
  /**
   * What of `result` was never shown: the rest of it when what streamed is its start, all of it
   * (`apart`) when what streamed differs, nothing when it is all shown. A saved answer recovery
   * cut (`cut`) is shown already only when it is exactly the start of what streamed that fits
   * in 4 MiB.
   */
  missing(result: string, cut: boolean): { text: string; apart: boolean } | undefined {
    if (this.length > result.length) {
      if (!cut) return { text: result, apart: true };
      const start = this.cut();
      return start.units === result.length && start.digest === hex(result)
        ? undefined
        : { text: result, apart: true };
    }
    if (hex(result.slice(0, this.length)) !== this.hash.copy().digest("hex"))
      return { text: result, apart: true };
    return this.length === result.length
      ? undefined
      : { text: result.slice(this.length), apart: false };
  }
}
