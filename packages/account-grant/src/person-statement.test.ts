import { expect, test } from "vitest";
import { encodeBase64url } from "./index.ts";
import {
  deviceKeyId,
  readStatement,
  statementText,
  verifyStatement,
  type PersonStatement,
} from "./person-statement.ts";

/*
 * A person's statement (ADR 0190, amendment 1): any verifier holding the device's public key
 * checks the very bytes signed, for one purpose, for a minute at most.
 */

async function device() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const publicKey = encodeBase64url(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const sign = async (text: string) =>
    encodeBase64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
    );
  return { publicKey, id: await deviceKeyId(publicKey), sign };
}

const base = (id: string): PersonStatement => ({
  account: "user_1",
  device: id,
  purpose: "standing",
  action: "PUT /v1/agents/a_1/security/permissions",
  target: "a_1",
  audience: "H".repeat(52),
  nonce: "n".repeat(43),
  iat: 1_000,
  exp: 31_000,
});

test("a statement verifies with the device key it names, while it lives", async () => {
  const key = await device();
  const text = statementText(base(key.id));
  const proof = await key.sign(text);
  expect(await verifyStatement({ text, proof, publicKey: key.publicKey, now: 2_000 })).toEqual(
    base(key.id),
  );
  expect(
    await verifyStatement({ text, proof, publicKey: key.publicKey, now: 31_000 }),
  ).toBeUndefined();
  const other = await device();
  expect(
    await verifyStatement({ text, proof, publicKey: other.publicKey, now: 2_000 }),
  ).toBeUndefined();
  expect(
    await verifyStatement({
      text,
      proof: await other.sign(text),
      publicKey: key.publicKey,
      now: 2_000,
    }),
  ).toBeUndefined();
});

test("only the canonical text of a short-lived statement reads as one", async () => {
  const key = await device();
  const text = statementText(base(key.id));
  expect(readStatement(text)).toEqual(base(key.id));
  expect(readStatement(`${text}\n`)).toBeUndefined();
  expect(readStatement(text.replace("purpose=standing", "purpose=anything"))).toBeUndefined();
  expect(readStatement(text.replace("exp=31000", "exp=31000.0"))).toBeUndefined();
  expect(() => statementText({ ...base(key.id), exp: 1_000 + 61_000 })).toThrow();
});
