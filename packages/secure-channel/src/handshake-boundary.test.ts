import { expect, it } from "vitest";
import { NoiseXX, keyPair, MAX_MESSAGE } from "./index.ts";

function handshakes() {
  const initiator = new NoiseXX({ initiator: true, staticKey: keyPair(), ephemeralKey: keyPair() });
  const responder = new NoiseXX({
    initiator: false,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
  });
  return { initiator, responder };
}

function turn(phase: number) {
  const { initiator, responder } = handshakes();
  if (phase >= 2) responder.readMessage(initiator.writeMessage());
  if (phase >= 3) initiator.readMessage(responder.writeMessage());
  return phase === 2
    ? { sender: responder, receiver: initiator }
    : { sender: initiator, receiver: responder };
}

it.each([
  [1, 32],
  [2, 96],
  [3, 64],
])("handshake message %i accepts its minimum and maximum received sizes", (phase, overhead) => {
  for (const size of [overhead, MAX_MESSAGE]) {
    const { sender, receiver } = turn(phase);
    const payload = new Uint8Array(size - overhead).fill(42);
    const message = sender.writeMessage(payload);
    expect(message.length).toBe(size);
    expect(receiver.readMessage(message)).toEqual(payload);
    sender.destroy();
    receiver.destroy();
  }
});

it.each([
  [1, 32],
  [2, 96],
  [3, 64],
])(
  "handshake message %i rejects received sizes outside its bounds and stays closed",
  (phase, minimum) => {
    for (const size of [minimum - 1, MAX_MESSAGE + 1]) {
      const { sender, receiver } = turn(phase);
      expect(() => receiver.readMessage(new Uint8Array(size))).toThrow(
        "Invalid Noise message size",
      );
      expect(() => receiver.readMessage(sender.writeMessage())).toThrow("Handshake closed");
      expect(() => receiver.writeMessage()).toThrow("Handshake closed");
      expect(() => receiver.transport).toThrow("Handshake incomplete");
      sender.destroy();
    }
  },
);

it("wrong-turn reads and writes reject without consuming any handshake phase", () => {
  const { initiator, responder } = handshakes();
  expect(() => responder.writeMessage()).toThrow("Wrong handshake turn");
  expect(() => initiator.readMessage(new Uint8Array(32))).toThrow("Wrong handshake turn");
  const first = initiator.writeMessage(new Uint8Array([1]));
  expect(() => initiator.writeMessage()).toThrow("Wrong handshake turn");
  expect(responder.readMessage(first)).toEqual(new Uint8Array([1]));
  expect(() => responder.readMessage(first)).toThrow("Wrong handshake turn");
  const second = responder.writeMessage(new Uint8Array([2]));
  expect(() => responder.writeMessage()).toThrow("Wrong handshake turn");
  expect(initiator.readMessage(second)).toEqual(new Uint8Array([2]));
  expect(() => initiator.readMessage(second)).toThrow("Wrong handshake turn");
  expect(responder.readMessage(initiator.writeMessage(new Uint8Array([3])))).toEqual(
    new Uint8Array([3]),
  );
  expect(
    responder.transport.receive.decrypt(initiator.transport.send.encrypt(new Uint8Array([4]))),
  ).toEqual(new Uint8Array([4]));
  expect(
    initiator.transport.receive.decrypt(responder.transport.send.encrypt(new Uint8Array([5]))),
  ).toEqual(new Uint8Array([5]));
  initiator.destroy();
  responder.destroy();
});

it("destroying a transport permanently rejects encryption, decryption and rekey in both directions", () => {
  const { initiator, responder } = handshakes();
  responder.readMessage(initiator.writeMessage());
  initiator.readMessage(responder.writeMessage());
  responder.readMessage(initiator.writeMessage());
  const a = initiator.transport;
  const b = responder.transport;
  const toA = b.send.encrypt(new Uint8Array([1]));
  const toB = a.send.encrypt(new Uint8Array([2]));
  a.destroy();
  b.destroy();
  for (const [transport, ciphertext] of [
    [a, toA],
    [b, toB],
  ] as const) {
    expect(() => transport.send.encrypt(new Uint8Array([3]))).toThrow("closed");
    expect(() => transport.receive.decrypt(ciphertext)).toThrow("closed");
    expect(() => transport.send.rekey()).toThrow("closed");
    expect(() => transport.receive.rekey()).toThrow("closed");
    transport.destroy();
    expect(() => transport.send.encrypt(new Uint8Array([4]))).toThrow("closed");
  }
});
