import { CipherState, MAX_MESSAGE } from "./cipher.ts";
import { concat, derive, empty, encode, keyPair, sha256, x25519 } from "./crypto.ts";
import type { KeyPair } from "./crypto.ts";
import type { Transport } from "./noise.ts";

/**
 * The cipher states a finished handshake splits into. An NK responder never learns a static
 * key from its peer, so this is a transport without `remoteStatic`.
 */
export type SessionKeys = Omit<Transport, "remoteStatic">;

/** The size of an NK first message with an empty payload: `e` plus the tag. */
export const NK_FIRST_MESSAGE_MINIMUM = 48;

type NkOptions = {
  prologue?: Uint8Array;
  /** Fresh ephemeral generated at the I/O boundary. Never reuse in production. */
  ephemeralKey: KeyPair;
};

export type NkInitiatorOptions = NkOptions & {
  /** The responder's static public key, known before the handshake (the pinned daemon key). */
  remoteStatic: Uint8Array;
};

export type NkResponderOptions = NkOptions & { staticKey: KeyPair };

/**
 * Noise revision 34, NK: `<- s; ...; -> e, es; <- e, ee`. The initiator knows the responder's
 * static key in advance, so its first message is already encrypted to it, and the handshake
 * ends after one round trip in the same `Split()` as XX. Only the responder is authenticated
 * at the Noise level; the initiator proves itself inside (ADR 0155).
 */
export class NoiseNK {
  readonly #initiator: boolean;
  #s: KeyPair | undefined;
  #e: KeyPair;
  #rs: Uint8Array | undefined;
  #re: Uint8Array | undefined;
  // The protocol name is exactly 32 bytes, so it is the initial hash as is.
  #h: Uint8Array = encode("Noise_NK_25519_ChaChaPoly_SHA256");
  #ck: Uint8Array = this.#h.slice();
  #cipher = new CipherState();
  #step = 0;
  #failed = false;
  #transport: SessionKeys | undefined;

  private constructor(
    initiator: boolean,
    ephemeral: KeyPair,
    responderStatic: Uint8Array,
    prologue: Uint8Array,
  ) {
    this.#initiator = initiator;
    this.#e = keyPair(ephemeral.privateKey);
    if (responderStatic.length !== 32) throw new Error("Invalid static public key");
    this.#mixHash(prologue);
    // The pre-message: the responder's static key, as both ends know it.
    this.#mixHash(responderStatic);
  }

  static initiator(options: NkInitiatorOptions): NoiseNK {
    const state = new NoiseNK(
      true,
      options.ephemeralKey,
      options.remoteStatic,
      options.prologue ?? empty,
    );
    state.#rs = options.remoteStatic.slice();
    return state;
  }

  static responder(options: NkResponderOptions): NoiseNK {
    const own = keyPair(options.staticKey.privateKey);
    const state = new NoiseNK(
      false,
      options.ephemeralKey,
      own.publicKey,
      options.prologue ?? empty,
    );
    state.#s = own;
    return state;
  }

  #mixHash(data: Uint8Array): void {
    this.#h = sha256(concat(this.#h, data));
  }

  #mixKey(privateKey: Uint8Array, remote: Uint8Array | undefined): void {
    if (!remote) throw new Error("Missing remote key");
    const shared = x25519.getSharedSecret(privateKey, remote);
    const [ck, k] = derive(this.#ck, shared);
    shared.fill(0);
    this.#ck.fill(0);
    this.#ck = ck;
    this.#cipher.destroy();
    this.#cipher = new CipherState(k);
    k.fill(0);
  }

  #crypt(data: Uint8Array, writing: boolean): Uint8Array {
    const output = writing
      ? this.#cipher.encrypt(data, this.#h)
      : this.#cipher.decrypt(data, this.#h);
    this.#mixHash(writing ? output : data);
    return output;
  }

  #check(writing: boolean): void {
    if (this.#failed || this.#step === 2) throw new Error("Handshake closed");
    if (writing !== (this.#initiator === (this.#step === 0)))
      throw new Error("Wrong handshake turn");
  }

  #finish(): void {
    this.#step++;
    if (this.#step !== 2) return;
    const [k1, k2] = derive(this.#ck, empty);
    const send = new CipherState(this.#initiator ? k1 : k2);
    const receive = new CipherState(this.#initiator ? k2 : k1);
    k1.fill(0);
    k2.fill(0);
    this.#transport = {
      send,
      receive,
      handshakeHash: this.#h.slice(),
      destroy() {
        send.destroy();
        receive.destroy();
      },
    };
    this.#erase();
  }

  #erase(): void {
    this.#s?.privateKey.fill(0);
    this.#e.privateKey.fill(0);
    this.#ck.fill(0);
    this.#cipher.destroy();
  }

  destroy(): void {
    this.#failed = true;
    this.#erase();
    this.#transport?.destroy();
  }

  writeMessage(payload: Uint8Array = empty): Uint8Array {
    this.#check(true);
    try {
      if (payload.length + 48 > MAX_MESSAGE) throw new Error("Noise message too large");
      this.#mixHash(this.#e.publicKey);
      // -> e, es (initiator: DH(e, rs)); <- e, ee (responder: DH(e, re)).
      this.#mixKey(this.#e.privateKey, this.#step === 0 ? this.#rs : this.#re);
      const sealed = this.#crypt(payload, true);
      this.#finish();
      return concat(this.#e.publicKey, sealed);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.#check(false);
    try {
      if (message.length < NK_FIRST_MESSAGE_MINIMUM || message.length > MAX_MESSAGE)
        throw new Error("Invalid Noise message size");
      this.#re = message.slice(0, 32);
      this.#mixHash(this.#re);
      // Responder reading `e, es`: DH(s, re). Initiator reading `e, ee`: DH(e, re).
      const own = this.#step === 0 ? this.#s : this.#e;
      if (!own) throw new Error("Missing static key");
      this.#mixKey(own.privateKey, this.#re);
      const payload = this.#crypt(message.subarray(32), false);
      this.#finish();
      return payload;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /** The first message's ephemeral key, once read: what replay suppression remembers. */
  get remoteEphemeral(): Uint8Array | undefined {
    return this.#re?.slice();
  }

  get transport(): SessionKeys {
    if (!this.#transport || this.#failed) throw new Error("Handshake incomplete");
    return this.#transport;
  }
}
