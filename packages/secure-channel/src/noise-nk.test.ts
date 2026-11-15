import { expect, it } from "vitest";
import { CipherState, MAX_MESSAGE, NoiseNK, NoiseXX, fingerprint, keyPair } from "./index.ts";
import type { SessionKeys } from "./index.ts";

// Noise NK beside XX (ADR 0155, step 2). Vectors: noise-nk-vectors.test.ts.

function nkPair() {
  const host = keyPair();
  const a = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() });
  const b = NoiseNK.responder({ staticKey: host, ephemeralKey: keyPair() });
  b.readMessage(a.writeMessage());
  a.readMessage(b.writeMessage());
  return [a.transport, b.transport] as const;
}

function xxPair() {
  const host = keyPair();
  const a = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
    pinnedFingerprint: fingerprint(host.publicKey),
  });
  const b = new NoiseXX({ initiator: false, staticKey: host, ephemeralKey: keyPair() });
  b.readMessage(a.writeMessage());
  a.readMessage(b.writeMessage());
  b.readMessage(a.writeMessage());
  return [a.transport, b.transport] as const;
}

/** What the channel does with a finished handshake: ordered, rekeyed, snapshotted, exported. */
function exercise([client, daemon]: readonly [SessionKeys, SessionKeys]) {
  const said = (text: string) => new TextEncoder().encode(text);
  const heard = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const log: string[] = [];
  log.push(heard(daemon.receive.decrypt(client.send.encrypt(said("up")))));
  log.push(heard(client.receive.decrypt(daemon.send.encrypt(said("down")))));
  client.send.rekey();
  daemon.receive.rekey();
  log.push(heard(daemon.receive.decrypt(client.send.encrypt(said("after rekey")))));
  const saved = client.receive.snapshot();
  const resumed = new CipherState(saved.key, saved.nonce);
  log.push(heard(resumed.decrypt(daemon.send.encrypt(said("resumed")))));
  const replay = client.send.encrypt(said("once"));
  log.push(heard(daemon.receive.decrypt(replay)));
  expect(() => daemon.receive.decrypt(replay)).toThrow();
  return log;
}

it("after NK the two cipher states interoperate exactly as after XX", () => {
  expect(exercise(nkPair())).toEqual(exercise(xxPair()));
  expect(exercise(nkPair())).toEqual(["up", "down", "after rekey", "resumed", "once"]);
});

it("the NK initiator's first message is readable only by the static key it was sent to", () => {
  const host = keyPair();
  const first = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() })
    .writeMessage(new TextEncoder().encode("early"));
  const other = NoiseNK.responder({ staticKey: keyPair(), ephemeralKey: keyPair() });
  expect(() => other.readMessage(first)).toThrow();
  expect(() => other.writeMessage()).toThrow("closed");
  const right = NoiseNK.responder({ staticKey: host, ephemeralKey: keyPair() });
  expect(new TextDecoder().decode(right.readMessage(first))).toBe("early");
});

it("a first message bound to another prologue is refused", () => {
  const host = keyPair();
  const first = NoiseNK.initiator({
    remoteStatic: host.publicKey,
    ephemeralKey: keyPair(),
    prologue: new TextEncoder().encode("ace daemon relay stream v2 nk"),
  }).writeMessage();
  const responder = NoiseNK.responder({
    staticKey: host,
    ephemeralKey: keyPair(),
    prologue: new TextEncoder().encode("ace daemon relay stream v1"),
  });
  expect(() => responder.readMessage(first)).toThrow();
});

it("an NK first message is never 32 bytes, so it can't be taken for an XX one", () => {
  const host = keyPair();
  const first = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() })
    .writeMessage();
  expect(first.length).toBe(48);
  const xxFirst = new NoiseXX({ initiator: true, staticKey: keyPair(), ephemeralKey: keyPair() })
    .writeMessage();
  expect(xxFirst.length).toBe(32);
  // An XX first message handed to an NK responder is refused for its size.
  const responder = NoiseNK.responder({ staticKey: host, ephemeralKey: keyPair() });
  expect(() => responder.readMessage(xxFirst)).toThrow("Invalid Noise message size");
});

it("NK keeps turns, bounds sizes and fails for good", () => {
  const host = keyPair();
  const a = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() });
  expect(() => a.readMessage(new Uint8Array(48))).toThrow("Wrong handshake turn");
  const b = NoiseNK.responder({ staticKey: host, ephemeralKey: keyPair() });
  expect(() => b.writeMessage()).toThrow("Wrong handshake turn");
  expect(() =>
    NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() }).writeMessage(
      new Uint8Array(MAX_MESSAGE - 47),
    ),
  ).toThrow("too large");
  const largest = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() })
    .writeMessage(new Uint8Array(MAX_MESSAGE - 48));
  expect(largest.length).toBe(MAX_MESSAGE);
  const tampered = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() })
    .writeMessage(new Uint8Array([1]));
  tampered[40] = (tampered[40] ?? 0) ^ 1;
  const reader = NoiseNK.responder({ staticKey: host, ephemeralKey: keyPair() });
  expect(() => reader.readMessage(tampered)).toThrow();
  expect(() => reader.readMessage(tampered)).toThrow("closed");
  expect(() => reader.transport).toThrow("incomplete");
});

it("the daemon's answer is bound to the first message: a replayed first message's session can't be read by the recorder", () => {
  const host = keyPair();
  const client = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() });
  const first = client.writeMessage(new TextEncoder().encode("hello.early"));
  // The recorder replays `first` to a daemon and gets an answer; it holds no ephemeral key.
  const replayed = NoiseNK.responder({ staticKey: host, ephemeralKey: keyPair() });
  replayed.readMessage(first);
  const answer = replayed.writeMessage();
  const sealed = replayed.transport.send.encrypt(new TextEncoder().encode("welcome"));
  // An attacker's own initiator with a guessed ephemeral can't read the answer.
  const guess = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() });
  guess.writeMessage();
  expect(() => guess.readMessage(answer)).toThrow();
  // Only the real client, with its ephemeral key, can.
  client.readMessage(answer);
  expect(new TextDecoder().decode(client.transport.receive.decrypt(sealed))).toBe("welcome");
});
