import { describe, it, expect } from "vitest";
import cacophony from "../fixtures/cacophony.json" with { type: "json" };
import snow from "../fixtures/snow.json" with { type: "json" };
import { NoiseXX, keyPair, fingerprint, CipherState, MAX_MESSAGE } from "./index.ts";
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const asHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function pair() {
  const host = keyPair();
  const a = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    pinnedFingerprint: fingerprint(host.publicKey),
  });
  const b = new NoiseXX({ initiator: false, staticKey: host });
  b.readMessage(a.writeMessage());
  a.readMessage(b.writeMessage());
  b.readMessage(a.writeMessage());
  return [a.transport, b.transport] as const;
}
describe("official Noise XX vectors", () => {
  for (const [source, fixture] of [
    ["cacophony", cacophony],
    ["snow", snow],
  ] as const) {
    for (const v of fixture.vectors)
      it(`matches every ${source} handshake and bidirectional transport byte`, () => {
        const a = new NoiseXX({
          initiator: true,
          staticKey: keyPair(hex(v.init_static)),
          ephemeralKey: keyPair(hex(v.init_ephemeral)),
          prologue: hex(v.init_prologue),
        });
        const b = new NoiseXX({
          initiator: false,
          staticKey: keyPair(hex(v.resp_static)),
          ephemeralKey: keyPair(hex(v.resp_ephemeral)),
          prologue: hex(v.resp_prologue),
        });
        v.messages.forEach((m, i) => {
          const sender = i % 2 === 0 ? a : b;
          const receiver = i % 2 === 0 ? b : a;
          const ciphertext =
            i < 3
              ? sender.writeMessage(hex(m.payload))
              : sender.transport.send.encrypt(hex(m.payload));
          expect(asHex(ciphertext)).toBe(m.ciphertext);
          const plain =
            i < 3
              ? receiver.readMessage(ciphertext)
              : receiver.transport.receive.decrypt(ciphertext);
          expect(asHex(plain)).toBe(m.payload);
        });
        if ("handshake_hash" in v) expect(asHex(a.transport.handshakeHash)).toBe(v.handshake_hash);
        expect(a.transport.handshakeHash).toEqual(b.transport.handshakeHash);
      });
  }
});
it("aborts before completing a handshake with the wrong pinned host fingerprint", () => {
  const a = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    pinnedFingerprint: fingerprint(keyPair().publicKey),
  });
  const b = new NoiseXX({ initiator: false, staticKey: keyPair() });
  b.readMessage(a.writeMessage());
  expect(() => a.readMessage(b.writeMessage())).toThrow("fingerprint");
  expect(() => a.writeMessage()).toThrow("closed");
});
it("rejects tampered, replayed and reordered ciphertext without advancing the receive nonce", () => {
  const [a, b] = pair();
  const first = a.send.encrypt(new Uint8Array([1]));
  const second = a.send.encrypt(new Uint8Array([2]));
  const corrupt = first.slice();
  corrupt[0] = corrupt[0]! ^ 1;
  expect(() => b.receive.decrypt(corrupt)).toThrow();
  expect(() => b.receive.decrypt(second)).toThrow();
  expect(b.receive.decrypt(first)).toEqual(new Uint8Array([1]));
  expect(() => b.receive.decrypt(first)).toThrow();
  expect(b.receive.decrypt(second)).toEqual(new Uint8Array([2]));
});
it("accepts maximum Noise transport size and rejects larger messages", () => {
  const [a, b] = pair();
  const message = a.send.encrypt(new Uint8Array(65519));
  expect(message.length).toBe(65535);
  expect(b.receive.decrypt(message).length).toBe(65519);
  expect(() => a.send.encrypt(new Uint8Array(65520))).toThrow("too large");
  expect(() => b.receive.decrypt(new Uint8Array(65536))).toThrow("too large");
});
it("coordinated directional rekeys keep the nonce and replace the old key", () => {
  const key = new Uint8Array(32).fill(7);
  const a = new CipherState(key),
    b = new CipherState(key),
    old = new CipherState(key);
  b.decrypt(a.encrypt(new Uint8Array([1])));
  old.decrypt(new CipherState(key).encrypt(new Uint8Array([1])));
  a.rekey();
  b.rekey();
  const message = a.encrypt(new Uint8Array([2]));
  // Native Node/OpenSSL reference: key 07 repeated 32 times, rekey after one send, payload 02 at nonce 1.
  expect(asHex(message)).toBe("acc100689abe3692f6d7cccfd594fc119c");
  expect(() => old.decrypt(message)).toThrow();
  expect(b.decrypt(message)).toEqual(new Uint8Array([2]));
});
it("invalid DH and oversized handshakes fail permanently", () => {
  const responder = new NoiseXX({ initiator: false, staticKey: keyPair() });
  responder.readMessage(new Uint8Array(32));
  expect(() => responder.writeMessage()).toThrow();
  expect(() => responder.writeMessage()).toThrow("closed");
  const initiator = new NoiseXX({ initiator: true, staticKey: keyPair() });
  expect(() => initiator.writeMessage(new Uint8Array(MAX_MESSAGE))).toThrow("too large");
});
