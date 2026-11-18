import { expect, test } from "vitest";
import { personOnlyRoute, personOnlyWrite, personStamp } from "./person-stamp.ts";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

test("only a change that could turn Full access on needs the person", () => {
  const bot = "/v1/agents/a_1/security/autonomy";
  const cases: [string, string, Buffer | undefined, unknown][] = [
    ["PUT", bot, json({ autonomy: "full_access" }), { target: "a_1", value: "full_access" }],
    // Following the parent or the machine can raise a bot too.
    ["PUT", bot, json({ autonomy: null }), { target: "a_1", value: "null" }],
    ["PUT", bot, json({}), { target: "a_1", value: "null" }],
    [
      "PUT",
      `${bot}?x=1`,
      json({ autonomy: "full_access" }),
      { target: "a_1", value: "full_access" },
    ],
    [
      "PUT",
      "/v1/agents/a%5F1/security/autonomy",
      json({ autonomy: "full_access" }),
      {
        target: "a_1",
        value: "full_access",
      },
    ],
    [
      "PUT",
      "/v1/security/autonomy",
      json({ autonomy: "full_access" }),
      {
        target: "machine",
        value: "full_access",
      },
    ],
    // Going back to the auto-review, and everything else, never does.
    ["PUT", bot, json({ autonomy: "auto_review" }), undefined],
    ["PUT", "/v1/security/autonomy", json({ autonomy: "auto_review" }), undefined],
    ["PUT", "/v1/agents/a_1/security/commands", json({ commands: "outside" }), undefined],
    ["GET", bot, undefined, undefined],
    // A body Spade can't read is refused there, stamp or not.
    ["PUT", bot, Buffer.from("{not json"), undefined],
  ];
  for (const [method, path, body, expected] of cases)
    expect(personOnlyWrite(method, path, body), `${method} ${path}`).toEqual(expected);
  expect(personOnlyRoute("PUT", bot)).toBe("a_1");
  expect(personOnlyRoute("POST", bot)).toBeUndefined();
});

test("the stamp is the one Spade checks, keyed with the shared key", () => {
  // The same vector is in spade-server's `security::attest` tests; computed independently with
  // Python's hmac.new(bytes(range(32)), message, sha256).
  const key = Uint8Array.from({ length: 32 }, (_, index) => index);
  expect(
    personStamp(
      key,
      { target: "a_1", value: "full_access" },
      1_700_000_000_000,
      "00112233445566778899aabbccddeeff",
    ),
  ).toBe(
    "v1.1700000000000.00112233445566778899aabbccddeeff.9d4be3f27e7c4b4e0aadae6e330483846f5ea77ecbe60121799f8c4b3c9b4149",
  );
});

test("accepting a bot moving here is the person's, stamped over the whole move as Spade checks it", () => {
  const accept = "/v1/moves/mv_0190ab/accept";
  const digest = "a".repeat(64);
  const body = {
    bot: "a_1",
    from: "host-laptop",
    via: "dev-laptop",
    to: "host-studio",
    digest,
    replaces: "bot",
  };
  expect(personOnlyRoute("PUT", accept)).toBe("move:mv_0190ab");
  expect(personOnlyWrite("PUT", accept, json(body))).toEqual({
    target: "move:mv_0190ab",
    value: `accept:a_1:host-laptop:dev-laptop:host-studio:${digest}:bot`,
  });
  expect(personOnlyWrite("PUT", accept, json({ ...body, replaces: "main" }))?.value).toMatch(
    /:main$/,
  );
  // Forwarded only stamped: any part Spade wouldn't take gets no stamp, and Spade refuses it.
  for (const odd of [
    { ...body, bot: "../a" },
    { ...body, from: "Host Laptop" },
    { ...body, via: undefined },
    { ...body, to: undefined },
    { ...body, digest: "abc" },
    { ...body, replaces: "everything" },
  ])
    expect(personOnlyWrite("PUT", accept, json(odd)), JSON.stringify(odd)).toBeUndefined();
  for (const path of ["/v1/moves/../accept", "/v1/moves/MV_1/accept"])
    expect(personOnlyWrite("PUT", path, json(body)), path).toBeUndefined();
});
