import { hkdfSync } from "node:crypto";
import { CipherState, MAX_MESSAGE } from "@ace/secure-channel";

/**
 * Lanes after their hello (`ace_media::lane_cipher`, plan "K1 contract clarifications"): every
 * byte, ace-media's accept byte included, in authenticated encryption. Keys: HKDF-SHA256 from
 * the lane secret, salt `"ace-media lane v1 keys"`, over the whole handshake transcript (magic,
 * tag, both nonces, both proofs) and a direction label. Records: a u16 BE length, then ChaCha20-Poly1305 from
 * `@ace/secure-channel`'s Noise CipherState, whose nonces are the per-direction sequence numbers;
 * each direction rekeys every `laneRekeyInterval` records, as ace-media's transport does. A
 * record that fails to open (modified, out of sequence, replayed, injected) closes the lane for
 * good. Vectors: `native/media/vectors/lane/proofs.json`.
 */

export const maxRecordPlain = MAX_MESSAGE - 16;
export const laneRekeyInterval = 2 ** 20;
const salt = new TextEncoder().encode("ace-media lane v1 keys");
const toMediaLabel = new TextEncoder().encode("daemon to media");
const toDaemonLabel = new TextEncoder().encode("media to daemon");

export type LaneKeys = { toMedia: Uint8Array; toDaemon: Uint8Array };

/** The whole handshake, bound into the record keys: magic, tag, both nonces, both proofs. */
export function laneTranscript(
  tag: number,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
  serverProof: Uint8Array,
  clientProof: Uint8Array,
): Uint8Array {
  return Uint8Array.from([
    0x41,
    0x43,
    0x45,
    0x4c,
    tag,
    ...clientNonce,
    ...serverNonce,
    ...serverProof,
    ...clientProof,
  ]);
}

export function deriveLaneKeys(secret: Uint8Array, transcript: Uint8Array): LaneKeys {
  const key = (label: Uint8Array) =>
    new Uint8Array(
      hkdfSync("sha256", secret, salt, Uint8Array.from([...transcript, ...label]), 32),
    );
  return { toMedia: key(toMediaLabel), toDaemon: key(toDaemonLabel) };
}

/** One end of a lane's record layer: seals what it sends, opens what arrives. */
export class LaneRecords {
  readonly #send: CipherState;
  readonly #receive: CipherState;
  readonly #interval: number;
  #sent = 0;
  #received = 0;
  /** Raw bytes of records still arriving. */
  #raw = new Uint8Array(0);
  #closed = false;

  /** Takes both keys and wipes the caller's copies. */
  constructor(sendKey: Uint8Array, receiveKey: Uint8Array, interval = laneRekeyInterval) {
    if (!Number.isInteger(interval) || interval <= 0) throw new Error("Invalid rekey interval");
    this.#send = new CipherState(sendKey);
    this.#receive = new CipherState(receiveKey);
    this.#interval = interval;
    sendKey.fill(0);
    receiveKey.fill(0);
  }

  /** `plain` as one or more records, back to back. */
  seal(plain: Uint8Array): Uint8Array {
    if (this.#closed) throw new Error("The lane is closed");
    const records: Uint8Array[] = [];
    let total = 0;
    for (let at = 0; at < plain.length || (at === 0 && plain.length === 0); at += maxRecordPlain) {
      const sealed = this.#send.encrypt(plain.subarray(at, at + maxRecordPlain));
      if (++this.#sent % this.#interval === 0) this.#send.rekey();
      const record = new Uint8Array(2 + sealed.length);
      new DataView(record.buffer).setUint16(0, sealed.length);
      record.set(sealed, 2);
      records.push(record);
      total += record.length;
      if (plain.length === 0) break;
    }
    if (records.length === 1 && records[0]) return records[0];
    const out = new Uint8Array(total);
    let offset = 0;
    for (const record of records) {
      out.set(record, offset);
      offset += record.length;
    }
    return out;
  }

  /** The plaintext of every record `chunk` completes. Throws, closing for good, on a bad one. */
  open(chunk: Uint8Array): Uint8Array[] {
    if (this.#closed) throw new Error("The lane is closed");
    const raw = new Uint8Array(this.#raw.length + chunk.length);
    raw.set(this.#raw);
    raw.set(chunk, this.#raw.length);
    const plains: Uint8Array[] = [];
    let at = 0;
    try {
      while (raw.length - at >= 2) {
        const length = new DataView(raw.buffer, raw.byteOffset + at).getUint16(0);
        if (length < 16) throw new Error("A lane record is too short");
        if (raw.length - at - 2 < length) break;
        plains.push(this.#receive.decrypt(raw.subarray(at + 2, at + 2 + length)));
        if (++this.#received % this.#interval === 0) this.#receive.rekey();
        at += 2 + length;
      }
    } catch (error) {
      this.close();
      throw error instanceof Error ? error : new Error("A lane record failed to open");
    }
    this.#raw = raw.slice(at);
    return plains;
  }

  close(): void {
    this.#closed = true;
    this.#send.destroy();
    this.#receive.destroy();
    this.#raw = new Uint8Array(0);
  }
}
