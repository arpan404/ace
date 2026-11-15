import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import nk from "../fixtures/nk.json" with { type: "json" };
import { NoiseNK, keyPair } from "./index.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const asHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/*
 * An independent NK, written from the Noise specification (revision 34, sections 5 and 7.4) on
 * `node:crypto` alone: OpenSSL's X25519, HKDF, SHA-256 and ChaCha20-Poly1305, not the noble
 * primitives the channel uses. The fixture was produced by `scripts/nk-vectors.ts` with ace's
 * NK; this derivation reproducing every byte is what checks it.
 */
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const privateObject = (raw: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: "der", type: "pkcs8" });
const publicOf = (raw: Uint8Array) =>
  createPublicKey(privateObject(raw)).export({ format: "der", type: "spki" }).subarray(12);
const dh = (raw: Uint8Array, remote: Uint8Array) =>
  diffieHellman({
    privateKey: privateObject(raw),
    publicKey: createPublicKey({
      key: Buffer.concat([X25519_SPKI, remote]),
      format: "der",
      type: "spki",
    }),
  });
const hash = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hkdf2 = (ck: Uint8Array, ikm: Uint8Array) => {
  const out = Buffer.from(hkdfSync("sha256", ikm, ck, Buffer.alloc(0), 64));
  return [out.subarray(0, 32), out.subarray(32)] as const;
};
const nonce = (n: number) => {
  const bytes = Buffer.alloc(12);
  bytes.writeBigUInt64LE(BigInt(n), 4);
  return bytes;
};
const seal = (key: Uint8Array, n: number, ad: Uint8Array, plain: Uint8Array) => {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce(n), { authTagLength: 16 });
  cipher.setAAD(ad, { plaintextLength: plain.length });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
};
const open = (key: Uint8Array, n: number, ad: Uint8Array, sealed: Uint8Array) => {
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce(n), { authTagLength: 16 });
  decipher.setAAD(ad, { plaintextLength: sealed.length - 16 });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
};

function independent(v: (typeof nk.vectors)[number]) {
  const rs = publicOf(hex(v.resp_static));
  const ie = hex(v.init_ephemeral);
  const re = hex(v.resp_ephemeral);
  let h: Uint8Array = Buffer.from("Noise_NK_25519_ChaChaPoly_SHA256");
  let ck: Uint8Array = h;
  h = hash(h, hex(v.init_prologue));
  h = hash(h, rs);
  // -> e, es
  const iePublic = publicOf(ie);
  h = hash(h, iePublic);
  let k: Uint8Array;
  [ck, k] = hkdf2(ck, dh(ie, rs));
  const first = seal(k, 0, h, hex(v.messages[0]?.payload ?? ""));
  h = hash(h, first);
  // <- e, ee
  const rePublic = publicOf(re);
  h = hash(h, rePublic);
  [ck, k] = hkdf2(ck, dh(re, iePublic));
  const second = seal(k, 0, h, hex(v.messages[1]?.payload ?? ""));
  h = hash(h, second);
  const [toResponder, toInitiator] = hkdf2(ck, new Uint8Array());
  const counters = { toResponder: 0, toInitiator: 0 };
  const transport = v.messages.slice(2).map((m, i) =>
    i % 2 === 0
      ? seal(toResponder, counters.toResponder++, new Uint8Array(), hex(m.payload))
      : seal(toInitiator, counters.toInitiator++, new Uint8Array(), hex(m.payload)),
  );
  return {
    ciphertexts: [Buffer.concat([iePublic, first]), Buffer.concat([rePublic, second]), ...transport],
    handshakeHash: h,
    keys: { toResponder, toInitiator },
  };
}

function handshake(v: (typeof nk.vectors)[number]) {
  const responderStatic = keyPair(hex(v.resp_static));
  const a = NoiseNK.initiator({
    remoteStatic: responderStatic.publicKey,
    ephemeralKey: keyPair(hex(v.init_ephemeral)),
    prologue: hex(v.init_prologue),
  });
  const b = NoiseNK.responder({
    staticKey: responderStatic,
    ephemeralKey: keyPair(hex(v.resp_ephemeral)),
    prologue: hex(v.resp_prologue),
  });
  return { a, b };
}

describe("Noise NK vectors", () => {
  nk.vectors.forEach((v, n) => {
    it(`vector ${n}: an independent derivation on node:crypto reproduces every byte`, () => {
      const derived = independent(v);
      expect(derived.ciphertexts.map(asHex)).toEqual(v.messages.map((m) => m.ciphertext));
      expect(asHex(derived.handshakeHash)).toBe(v.handshake_hash);
      // And it opens what it sealed, so the derivation is not one-sided.
      const last = v.messages.at(-1);
      if (last && v.messages.length % 2 === 0)
        expect(
          asHex(
            open(
              derived.keys.toInitiator,
              (v.messages.length - 2) / 2 - 1,
              new Uint8Array(),
              hex(last.ciphertext),
            ),
          ),
        ).toBe(last.payload);
    });

    it(`vector ${n}: the channel's NK writes and reads every handshake and transport byte`, () => {
      const { a, b } = handshake(v);
      v.messages.forEach((m, i) => {
        const sender = i % 2 === 0 ? a : b;
        const receiver = i % 2 === 0 ? b : a;
        const ciphertext =
          i < 2 ? sender.writeMessage(hex(m.payload)) : sender.transport.send.encrypt(hex(m.payload));
        expect(asHex(ciphertext)).toBe(m.ciphertext);
        const plain =
          i < 2 ? receiver.readMessage(ciphertext) : receiver.transport.receive.decrypt(ciphertext);
        expect(asHex(plain)).toBe(m.payload);
      });
      expect(asHex(a.transport.handshakeHash)).toBe(v.handshake_hash);
      expect(b.transport.handshakeHash).toEqual(a.transport.handshakeHash);
    });
  });
});

