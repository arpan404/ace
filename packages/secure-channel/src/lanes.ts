import { MAX_MESSAGE } from "./cipher.ts";

/**
 * Message framing inside a relayed stream's encrypted fragments (ADR 0110).
 *
 * A data fragment's plaintext is one flag byte and then a piece of one message. The flag is the
 * message's kind (0 JSON, 2 binary, 4 deflated JSON), plus 1 on its last fragment. Every
 * fragment but a message's last is full (`FULL_FRAGMENT` bytes of plaintext).
 *
 * Lanes (`hello.flowControl` has `lanes`) let a sender interleave the fragments of two
 * messages, so an interactive message need not wait behind the rest of a bulk one. A bulk-lane
 * fragment carries `BULK_LANE` in its flag; an interactive one is framed exactly as without
 * lanes. Within a lane, a message's fragments still come back to back and messages keep their
 * order. The marker is inside the plaintext, so a relay never sees it; fragments are still
 * encrypted and decrypted one after another in the stream's single nonce order.
 */
export const FULL_FRAGMENT = MAX_MESSAGE - 16;
export const BULK_LANE = 0x10;
export const INTERACTIVE = 0;
export const BULK = 1;
export type Lane = typeof INTERACTIVE | typeof BULK;
export const fragmentKinds = { json: 0, binary: 2, deflated: 4 } as const;
export type FragmentKind = (typeof fragmentKinds)[keyof typeof fragmentKinds];

/** The flag byte of a message's fragment. */
export function fragmentFlag(kind: FragmentKind, last: boolean, lane: Lane): number {
  return kind + (last ? 1 : 0) + (lane === BULK ? BULK_LANE : 0);
}

export interface AssembledMessage {
  kind: FragmentKind;
  data: Uint8Array;
}

export interface AssemblerLimits {
  /** Whether this end announced lanes: only then may a fragment carry `BULK_LANE`. */
  lanes: boolean;
  binaryLimit: number;
  logicalLimit: number;
}

interface Partial {
  kind: FragmentKind;
  size: number;
  chunks: Uint8Array[];
}

/**
 * Puts decrypted data fragments back into messages, one partial message per lane. Any fragment
 * that breaks the framing throws, and the channel ends, as before lanes: a short fragment that
 * isn't a message's last, a kind change inside a message, an unknown flag, a message too big.
 * The caller owns the fragments it passes; chunks are zeroed once copied into a message.
 */
export class FragmentAssembler {
  readonly #limits: AssemblerLimits;
  readonly #partial: (Partial | undefined)[] = [undefined, undefined];
  constructor(limits: AssemblerLimits) {
    this.#limits = limits;
  }

  /** Bytes held in partial messages. */
  get bufferedBytes(): number {
    return (this.#partial[0]?.size ?? 0) + (this.#partial[1]?.size ?? 0);
  }

  /** Add one fragment: the whole message once its last fragment arrives, else undefined. */
  add(plain: Uint8Array): AssembledMessage | undefined {
    const raw = plain[0];
    if (raw === undefined || plain.length < 2) throw new Error("Invalid encrypted fragment");
    const lane: Lane = this.#limits.lanes && raw & BULK_LANE ? BULK : INTERACTIVE;
    const flag = lane === BULK ? raw - BULK_LANE : raw;
    if (flag > 5 || (flag % 2 === 0 && plain.length !== FULL_FRAGMENT))
      throw new Error("Invalid encrypted fragment");
    const kind = (flag - (flag % 2)) as FragmentKind;
    const partial = this.#partial[lane] ?? { kind, size: 0, chunks: [] };
    if (partial.kind !== kind) throw new Error("Mixed fragment kinds");
    this.#partial[lane] = partial;
    partial.chunks.push(plain.subarray(1));
    partial.size += plain.length - 1;
    if (kind === fragmentKinds.binary && partial.size > this.#limits.binaryLimit)
      throw new Error("Binary message too large");
    if (partial.size > this.#limits.logicalLimit) throw new Error("Logical message too large");
    if (flag % 2 === 0) return undefined;
    this.#partial[lane] = undefined;
    const data = new Uint8Array(partial.size);
    let offset = 0;
    for (const chunk of partial.chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
      chunk.fill(0);
    }
    return { kind, data };
  }

  /** Drop every partial message, zeroing what it held. */
  clear(): void {
    for (const partial of this.#partial) for (const chunk of partial?.chunks ?? []) chunk.fill(0);
    this.#partial.fill(undefined);
  }
}
