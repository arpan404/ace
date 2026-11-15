/**
 * Writes `fixtures/nk.json`: Noise_NK_25519_ChaChaPoly_SHA256 vectors made with ace's own NK
 * (`src/noise-nk.ts`) from fixed keys. `src/noise-nk.test.ts` checks them against an independent
 * derivation on `node:crypto`. Run: `bun packages/secure-channel/scripts/nk-vectors.ts`.
 */
import { writeFileSync } from "node:fs";
import { NoiseNK, keyPair } from "../src/index.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const asHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Keys and prologue from the vendored cacophony XX vector, so they are not ours to choose.
const keys = {
  init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
};
const cases = [
  { prologue: "4a6f686e2047616c74", payloads: ["4c756477696720766f6e204d69736573", "4d757272617920526f746862617264", "462e20412e20486179656b", "4361726c204d656e676572"] },
  { prologue: "616365206461656d6f6e2072656c61792073747265616d207632206e6b", payloads: ["", "", "00", "ff".repeat(40)] },
];

const vectors = cases.map(({ prologue, payloads }) => {
  const responderStatic = keyPair(hex(keys.resp_static));
  const a = NoiseNK.initiator({
    remoteStatic: responderStatic.publicKey,
    ephemeralKey: keyPair(hex(keys.init_ephemeral)),
    prologue: hex(prologue),
  });
  const b = NoiseNK.responder({
    staticKey: responderStatic,
    ephemeralKey: keyPair(hex(keys.resp_ephemeral)),
    prologue: hex(prologue),
  });
  const messages = payloads.map((payload, i) => {
    const sender = i % 2 === 0 ? a : b;
    const receiver = i % 2 === 0 ? b : a;
    const ciphertext =
      i < 2 ? sender.writeMessage(hex(payload)) : sender.transport.send.encrypt(hex(payload));
    if (i < 2) receiver.readMessage(ciphertext);
    else receiver.transport.receive.decrypt(ciphertext);
    return { payload, ciphertext: asHex(ciphertext) };
  });
  return {
    protocol_name: "Noise_NK_25519_ChaChaPoly_SHA256",
    init_prologue: prologue,
    ...keys,
    resp_prologue: prologue,
    handshake_hash: asHex(a.transport.handshakeHash),
    messages,
  };
});

writeFileSync(
  new URL("../fixtures/nk.json", import.meta.url),
  `${JSON.stringify({ vectors }, null, 2)}\n`,
);
