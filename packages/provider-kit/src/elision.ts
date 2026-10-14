/**
 * Streaming elision of heavy JSON strings in provider output.
 *
 * Providers store images inline as base64: OpenCode attachments and tool output as data URLs,
 * Codex generated images as raw base64. One image is megabytes, and every history page, event
 * or JSON-RPC line that carries it would be too. ace never reads those bytes back; it needs the
 * structure around them. So a string that outgrows `holdBytes` and looks binary is replaced
 * with a short placeholder, and any other string keeps its first `textBytes` plus a marker.
 *
 * Work is one pass over the bytes and memory is `holdBytes` per stream, whatever the input
 * size. A raw line feed closes any open string: valid JSON never has one inside a string, and
 * SSE and JSON-RPC frames are line-delimited, so a malformed frame cannot desynchronise the
 * next one.
 */
import { Transform } from "node:stream";

export type ElisionLimits = { holdBytes: number; textBytes: number };

const quote = 34,
  backslash = 92,
  lineFeed = 10,
  letterU = 117;
const outside = 0,
  holding = 1,
  passing = 2,
  eliding = 3,
  truncating = 4;
const encoder = new TextEncoder();
const base64Alphabet = new Uint8Array(256);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_")
  base64Alphabet[c.charCodeAt(0)] = 1;

export class JsonElider {
  readonly #limits: ElisionLimits;
  readonly #out: (chunk: Uint8Array) => void;
  readonly #hold: Uint8Array;
  #held = 0;
  #mode = outside;
  #escape = false;
  #unicode = 0;
  #bytes = 0;
  #label = "";
  constructor(limits: ElisionLimits, out: (chunk: Uint8Array) => void) {
    if (limits.holdBytes < 64 || limits.textBytes < limits.holdBytes)
      throw new RangeError("Invalid JSON elision limits");
    this.#limits = limits;
    this.#out = out;
    this.#hold = new Uint8Array(limits.holdBytes);
  }
  push(chunk: Uint8Array): void {
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i] ?? 0;
      if (this.#mode === outside) {
        if (byte !== quote) continue;
        this.#emit(chunk.subarray(from, i + 1));
        from = i + 1;
        this.#open();
        continue;
      }
      const closes = byte === lineFeed || (byte === quote && !this.#escape && !this.#unicode);
      if (closes) {
        // A passing string is still part of the pending range; anything else was emitted here.
        if (this.#mode !== passing) from = i;
        this.#close();
        continue;
      }
      if (
        this.#mode === passing &&
        this.#bytes >= this.#limits.textBytes &&
        !this.#escape &&
        !this.#unicode &&
        (byte < 0x80 || byte >= 0xc0)
      ) {
        // Cut only between whole characters and escapes so the kept head stays valid JSON.
        this.#emit(chunk.subarray(from, i));
        this.#mode = truncating;
      }
      this.#track(byte);
      if (this.#mode !== holding) continue;
      this.#hold[this.#held++] = byte;
      if (this.#held < this.#limits.holdBytes) continue;
      const label = this.#binaryLabel();
      if (label !== undefined) {
        this.#label = label;
        this.#mode = eliding;
      } else {
        this.#emit(this.#hold.slice(0, this.#held));
        this.#held = 0;
        this.#mode = passing;
        from = i + 1;
      }
    }
    if (this.#mode === outside || this.#mode === passing) this.#emit(chunk.subarray(from));
  }
  /** Flush an unterminated string as-is; the caller's parser reports the malformed body. */
  end(): void {
    if (this.#mode !== outside) this.#close();
  }
  #open(): void {
    this.#mode = holding;
    this.#held = 0;
    this.#bytes = 0;
    this.#escape = false;
    this.#unicode = 0;
  }
  #track(byte: number): void {
    this.#bytes++;
    if (this.#unicode) this.#unicode--;
    else if (this.#escape) {
      this.#escape = false;
      if (byte === letterU) this.#unicode = 4;
    } else if (byte === backslash) this.#escape = true;
  }
  #close(): void {
    // The hold buffer is reused, so emitted held bytes are a copy the consumer may keep.
    if (this.#mode === holding) this.#emit(this.#hold.slice(0, this.#held));
    else if (this.#mode === eliding)
      this.#emit(encoder.encode(`[ace: ${this.#bytes} bytes of ${this.#label} elided]`));
    else if (this.#mode === truncating)
      this.#emit(
        encoder.encode(`[ace: ${this.#bytes - this.#limits.textBytes} more bytes truncated]`),
      );
    this.#held = 0;
    this.#mode = outside;
  }
  #binaryLabel(): string | undefined {
    const hold = this.#hold;
    // data:<mime>[;params];base64,<payload>
    if (hold[0] === 100 && hold[1] === 97 && hold[2] === 116 && hold[3] === 97 && hold[4] === 58) {
      const comma = hold.indexOf(44);
      if (comma > 0 && comma <= 256) {
        const header = new TextDecoder().decode(hold.subarray(0, comma));
        if (/^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64$/.test(header)) return header;
      }
    }
    for (const byte of hold) if (!base64Alphabet[byte]) return undefined;
    return "base64 data";
  }
  #emit(bytes: Uint8Array): void {
    if (bytes.byteLength) this.#out(bytes);
  }
}

/** Byte-stream form for process pipes: each input chunk yields at most one output chunk. */
export function jsonElision(limits: ElisionLimits): Transform {
  let pieces: Uint8Array[] = [];
  const elider = new JsonElider(limits, (piece) => pieces.push(piece));
  const take = () => {
    const out = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    pieces = [];
    return out?.byteLength ? out : undefined;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      elider.push(chunk);
      done(null, take());
    },
    flush(done) {
      elider.end();
      done(null, take());
    },
  });
}
