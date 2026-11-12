import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { encodeBase64url } from "@ace/account-grant";
import { open, seal } from "./seal.ts";
import type { SealPurpose } from "./seal.ts";
import { spadeSide } from "./testing.ts";

type Vector = {
  spade_private_key: string;
  spade_public_key: string;
  cloud_private_key: string;
  app: string;
  purpose: SealPurpose;
  plaintext: string;
  sealed: { epk: string; ciphertext: string };
};

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const bytes = (text: string) => new TextEncoder().encode(text);

it("the vectors Spade's Rust checks seal and open byte for byte here too", async () => {
  const { cases } = JSON.parse(
    await readFile(
      join(import.meta.dirname, "../../../../spade/crates/spade-cloud-wire/test-vectors.json"),
      "utf8",
    ),
  ) as { cases: Vector[] };
  expect(cases.length).toBeGreaterThan(0);
  for (const each of cases) {
    const context = { app: each.app, purpose: each.purpose };
    expect(
      seal(each.spade_public_key, bytes(each.plaintext), context, hex(each.cloud_private_key)),
    ).toEqual(each.sealed);
    expect(new TextDecoder().decode(open(each.sealed, context, hex(each.spade_private_key)))).toBe(
      each.plaintext,
    );
  }
});

it("a sealed answer opens only with Spade's key, for its own app and purpose, untampered", () => {
  const spade = spadeSide(1);
  const context = { app: "asana", purpose: "finish" } as const;
  const sealed = seal(
    spade.publicKey,
    bytes('{"access_token":"a"}'),
    context,
    spadeSide(9).privateKey,
  );
  expect(sealed.ciphertext).not.toContain("access_token");
  expect(() => open(sealed, context, spadeSide(3).privateKey)).toThrow("did not open");
  expect(() => open(sealed, { app: "box", purpose: "finish" }, spade.privateKey)).toThrow();
  expect(() => open(sealed, { app: "asana", purpose: "refresh" }, spade.privateKey)).toThrow();
  const tampered = Buffer.from(sealed.ciphertext, "base64url");
  tampered[0]! ^= 1;
  expect(() =>
    open({ ...sealed, ciphertext: encodeBase64url(tampered) }, context, spade.privateKey),
  ).toThrow();
  expect(new TextDecoder().decode(open(sealed, context, spade.privateKey))).toBe(
    '{"access_token":"a"}',
  );
});

it("sealing to something that is not a key, or to a low-order point, is refused", () => {
  const context = { app: "asana", purpose: "finish" } as const;
  const ours = spadeSide(9).privateKey;
  expect(() => seal("short", bytes("x"), context, ours)).toThrow("X25519");
  expect(() => seal(encodeBase64url(new Uint8Array(32)), bytes("x"), context, ours)).toThrow(
    "X25519",
  );
});
