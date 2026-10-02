import { CipherState, MAX_MESSAGE } from "./cipher.ts";
import { concat, derive, empty, encode, fingerprint, keyPair, sha256, x25519 } from "./crypto.ts";
import type { KeyPair } from "./crypto.ts";
export type Transport = {
  send: CipherState;
  receive: CipherState;
  handshakeHash: Uint8Array;
  remoteStatic: Uint8Array;
  destroy(): void;
};
export type HandshakeOptions = {
  initiator: boolean;
  staticKey: KeyPair;
  prologue?: Uint8Array;
  pinnedFingerprint?: string;
  /** Fresh ephemeral generated at the I/O boundary. Never reuse in production. */
  ephemeralKey: KeyPair;
};
/** Noise revision 34, XX: -> e; <- e, ee, s, es; -> s, se. */
export class NoiseXX {
  #options: Pick<HandshakeOptions, "initiator" | "pinnedFingerprint">;
  #s: KeyPair;
  #e: KeyPair;
  #rs: Uint8Array | undefined;
  #re: Uint8Array | undefined;
  #h: Uint8Array = (() => {
    const name = encode("Noise_XX_25519_ChaChaPoly_SHA256");
    return name.length > 32 ? sha256(name) : concat(name, new Uint8Array(32 - name.length));
  })();
  #ck: Uint8Array = this.#h.slice();
  #cipher = new CipherState();
  #step = 0;
  #failed = false;
  #transport: Transport | undefined;
  constructor(options: HandshakeOptions) {
    this.#options = {
      initiator: options.initiator,
      ...(options.pinnedFingerprint !== undefined
        ? { pinnedFingerprint: options.pinnedFingerprint }
        : {}),
    };
    this.#s = keyPair(options.staticKey.privateKey);
    this.#e = keyPair(options.ephemeralKey.privateKey);
    this.#mixHash(options.prologue ?? empty);
  }
  #mixHash(data: Uint8Array): void {
    this.#h = sha256(concat(this.#h, data));
  }
  #mixKey(local: KeyPair, remote: Uint8Array | undefined): void {
    if (!remote) throw new Error("Missing remote key");
    const shared = x25519.getSharedSecret(local.privateKey, remote);
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
    if (this.#failed || this.#step === 3) throw new Error("Handshake closed");
    const initiatorTurn = this.#step !== 1;
    if (writing !== (this.#options.initiator === initiatorTurn))
      throw new Error("Wrong handshake turn");
  }
  #finish(): void {
    this.#step++;
    if (this.#step !== 3) return;
    if (!this.#rs) throw new Error("Missing remote identity");
    const [k1, k2] = derive(this.#ck, empty);
    const send = new CipherState(this.#options.initiator ? k1 : k2);
    const receive = new CipherState(this.#options.initiator ? k2 : k1);
    k1.fill(0);
    k2.fill(0);
    this.#transport = {
      send,
      receive,
      handshakeHash: this.#h.slice(),
      remoteStatic: this.#rs.slice(),
      destroy() {
        send.destroy();
        receive.destroy();
      },
    };
    this.#erase();
  }
  #erase(): void {
    this.#s.privateKey.fill(0);
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
      const overhead = this.#step === 0 ? 32 : this.#step === 1 ? 96 : 64;
      if (payload.length + overhead > MAX_MESSAGE) throw new Error("Noise message too large");
      const parts: Uint8Array[] = [];
      if (this.#step < 2) {
        parts.push(this.#e.publicKey);
        this.#mixHash(this.#e.publicKey);
      }
      if (this.#step === 1) {
        this.#mixKey(this.#e, this.#re);
        parts.push(this.#crypt(this.#s.publicKey, true));
        this.#mixKey(this.#s, this.#re);
      }
      if (this.#step === 2) {
        parts.push(this.#crypt(this.#s.publicKey, true));
        this.#mixKey(this.#s, this.#re);
      }
      parts.push(this.#crypt(payload, true));
      this.#finish();
      return concat(...parts);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  readMessage(message: Uint8Array): Uint8Array {
    this.#check(false);
    try {
      const minimum = this.#step === 0 ? 32 : this.#step === 1 ? 96 : 64;
      if (message.length < minimum || message.length > MAX_MESSAGE)
        throw new Error("Invalid Noise message size");
      let offset = 0;
      if (this.#step < 2) {
        this.#re = message.slice(0, 32);
        offset = 32;
        this.#mixHash(this.#re);
      }
      if (this.#step === 1) this.#mixKey(this.#e, this.#re);
      if (this.#step > 0) {
        this.#rs = this.#crypt(message.subarray(offset, offset + 48), false);
        offset += 48;
        if (
          this.#options.pinnedFingerprint !== undefined &&
          fingerprint(this.#rs) !== this.#options.pinnedFingerprint
        )
          throw new Error("Pinned fingerprint mismatch");
        this.#mixKey(this.#e, this.#rs);
      }
      const payload = this.#crypt(message.subarray(offset), false);
      this.#finish();
      return payload;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  get transport(): Transport {
    if (!this.#transport || this.#failed) throw new Error("Handshake incomplete");
    return this.#transport;
  }
}
