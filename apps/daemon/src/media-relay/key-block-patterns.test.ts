import { expect, it } from "vitest";
import { decodeKeyBlock } from "@ace/media/key-block";
import {
  CipherState,
  FlowCredit,
  NoiseNK,
  NoiseXX,
  fingerprint,
  keyPair,
  type SessionKeys,
} from "@ace/secure-channel";
import { writeKeyBlock } from "./handover.ts";

// The 120-byte key block ace-media installs (docs/media/plan.md, "Key hand-over") after either
// Noise pattern (ADR 0155): same layout, offsets and meaning; different bytes, as for any two
// sessions; nothing reads them as if they matched.

function xx(): [SessionKeys, SessionKeys] {
  const host = keyPair();
  const client = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
    pinnedFingerprint: fingerprint(host.publicKey),
  });
  const daemon = new NoiseXX({ initiator: false, staticKey: host, ephemeralKey: keyPair() });
  daemon.readMessage(client.writeMessage());
  client.readMessage(daemon.writeMessage());
  daemon.readMessage(client.writeMessage());
  return [client.transport, daemon.transport];
}

function nk(): [SessionKeys, SessionKeys] {
  const host = keyPair();
  const client = NoiseNK.initiator({ remoteStatic: host.publicKey, ephemeralKey: keyPair() });
  const daemon = NoiseNK.responder({ staticKey: host, ephemeralKey: keyPair() });
  daemon.readMessage(client.writeMessage());
  client.readMessage(daemon.writeMessage());
  return [client.transport, daemon.transport];
}

/** Some traffic, then the daemon's block; the client keeps its own states. */
function handOver([client, daemon]: [SessionKeys, SessionKeys]) {
  for (let i = 0; i < 3; i++) daemon.receive.decrypt(client.send.encrypt(new Uint8Array([i])));
  for (let i = 0; i < 2; i++) client.receive.decrypt(daemon.send.encrypt(new Uint8Array([i])));
  const flow = new FlowCredit();
  flow.start();
  const block = new Uint8Array(120);
  writeKeyBlock(daemon, { sent: 2n, received: 3n }, flow, block);
  return { block, client };
}

it("after NK and after XX the block decodes to the same fields, and each resumes its own stream", () => {
  const results = [handOver(xx()), handOver(nk())];
  const decoded = results.map(({ block }) => decodeKeyBlock(block));
  const meaning = decoded.map(({ sendKey: _s, receiveKey: _r, ...rest }) => rest);
  expect(meaning[0]).toEqual(meaning[1]);
  expect(meaning[1]).toMatchObject({ sendNonce: 2n, receiveNonce: 3n, framesSent: 2n });
  for (const [n, { block, client }] of results.entries()) {
    const fields = decoded[n];
    if (!fields) throw new Error("No block");
    // ace-media installs the keys and nonces it is given, and talks to this client.
    const media = {
      send: new CipherState(fields.sendKey, fields.sendNonce),
      receive: new CipherState(fields.receiveKey, fields.receiveNonce),
    };
    expect([...client.receive.decrypt(media.send.encrypt(new Uint8Array([7])))]).toEqual([7]);
    expect([...media.receive.decrypt(client.send.encrypt(new Uint8Array([8])))]).toEqual([8]);
    block.fill(0);
  }
});

it("the keys in two blocks differ, whatever the pattern, so nothing may expect them to match", () => {
  const keys = [handOver(xx()), handOver(nk()), handOver(nk())].map(({ block }) =>
    Buffer.from(block.subarray(0, 64)).toString("hex"),
  );
  expect(new Set(keys).size).toBe(3);
});
