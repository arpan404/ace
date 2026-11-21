import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { expect, test } from "vitest";
import { canonicalJson, cardKey, signCard, type CardJwk } from "./card-signature.ts";

test("cards are canonicalized as RFC 8785's own examples are", () => {
  // RFC 8785 §3.2.2: numbers, strings and literals.
  const sample = JSON.parse(
    '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
  );
  expect(canonicalJson(sample)).toBe(
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
  // RFC 8785 §3.2.3: keys in UTF-16 code unit order (U+FB33 after the surrogate pair).
  const keys = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\ud83d\ude00": "Emoji: Grinning Face",
    "\u0080": "Control",
    "\u00f6": "Latin Small Letter O With Diaeresis",
  };
  expect(canonicalJson(keys)).toBe(
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
      '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
  );
  expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: "x" })).toBe('{"a":"x","b":[1,{"c":2,"d":1}]}');
});

function verifies(card: Record<string, unknown>, jwk: CardJwk): boolean {
  const [signature] = card["signatures"] as { protected: string; signature: string }[];
  if (!signature) return false;
  const { signatures: _signatures, ...payload } = card;
  const input = `${signature.protected}.${Buffer.from(canonicalJson(payload)).toString("base64url")}`;
  return verify(
    "sha256",
    Buffer.from(input),
    { key: createPublicKey({ key: { ...jwk }, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature.signature, "base64url"),
  );
}

test("a signed card verifies with the public key it names, and not once anything in it changes", () => {
  const key = cardKey(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
  const card = {
    name: "Spade",
    skills: [{ id: "flight_watcher__cheapest_fare", description: "Fares." }],
    // A signature it had before is replaced, never signed over.
    signatures: [{ protected: "old", signature: "old" }],
  };
  const signed = signCard(card, key, "https://machine.example/spade/jwks.json");
  const [only, ...more] = signed["signatures"] as { protected: string }[];
  expect(more).toEqual([]);
  expect(JSON.parse(Buffer.from(only?.protected ?? "", "base64url").toString())).toEqual({
    alg: "ES256",
    typ: "JOSE",
    kid: key.jwk.kid,
    jku: "https://machine.example/spade/jwks.json",
  });
  expect(verifies(signed, key.jwk)).toBe(true);
  // Field order is not what is signed: the canonical form is.
  const reordered = Object.fromEntries(Object.entries(signed).toReversed());
  expect(verifies(reordered, key.jwk)).toBe(true);

  const tampered = {
    ...signed,
    skills: [{ id: "flight_watcher__cheapest_fare", description: "Free." }],
  };
  expect(verifies(tampered, key.jwk)).toBe(false);
  const other = cardKey(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
  expect(verifies(signed, other.jwk)).toBe(false);
  expect(other.jwk.kid).not.toBe(key.jwk.kid);
});
