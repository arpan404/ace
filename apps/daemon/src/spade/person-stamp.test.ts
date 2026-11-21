import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { personOnlyRoute, personOnlyWrite, personStamp } from "./person-stamp.ts";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");

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

test("passing Spade's host choice on is the person's, stamped over the whole record", () => {
  const record = { host: "host-studio", version: 3, at: 1_700_000, by: "move" };
  const body = Buffer.from(JSON.stringify(record));
  expect(personOnlyWrite("PUT", "/v1/main/host", body)).toEqual({
    target: "main-host",
    value: "host:host-studio:3:1700000:move",
  });
  // A choice the person makes by hand, or one that isn't a record, gets no stamp: Spade then
  // refuses it.
  for (const odd of [
    { ...record, by: "person" },
    { ...record, version: 0 },
    { ...record, host: "a b" },
    { host: "host-studio" },
  ])
    expect(personOnlyWrite("PUT", "/v1/main/host", Buffer.from(JSON.stringify(odd)))).toBe(
      undefined,
    );
  expect(personOnlyWrite("GET", "/v1/main/host", body)).toBe(undefined);
});

test("turning a Permissions switch on, or changing the never-use list, is stamped when the caller can prove it", () => {
  const bot = "/v1/agents/a_1/security/permissions";
  const machine = "/v1/security/permissions";
  const never = "/v1/security/never-apps";
  const cases: [string, Buffer | undefined, unknown][] = [
    [
      bot,
      json({ key: "computer_use", on: true }),
      { target: "a_1", value: "permission:computer_use:true", optional: true },
    ],
    // Following the default can raise a bot.
    [
      bot,
      json({ key: "browser", on: null }),
      { target: "a_1", value: "permission:browser:null", optional: true },
    ],
    [
      bot,
      json({ key: "browser" }),
      { target: "a_1", value: "permission:browser:null", optional: true },
    ],
    [
      machine,
      json({ key: "devices", on: true }),
      { target: "machine", value: "permission:devices:true", optional: true },
    ],
    // The list as sent, whatever it adds or drops: the daemon can't see which.
    [
      never,
      json({ apps: ["1Password", "Mail"] }),
      { target: "machine", value: "never_apps:1Password\u001fMail", optional: true },
    ],
    // Turning a switch off never does, nor does a body Spade won't take.
    [bot, json({ key: "computer_use", on: false }), undefined],
    [machine, json({ key: "devices", on: false }), undefined],
    [machine, json({ key: "devices" }), undefined],
    [bot, json({ key: "Not A Switch", on: true }), undefined],
    [never, json({ apps: [1] }), undefined],
    [bot, Buffer.from("{not json"), undefined],
  ];
  for (const [path, body, expected] of cases)
    expect(personOnlyWrite("PUT", path, body), `${path} ${body?.toString()}`).toEqual(expected);
  // Sent in parts, it couldn't be read whole before it is stamped.
  for (const path of [bot, machine, never]) expect(personOnlyRoute("PUT", path)).toBeDefined();
});

test("a change that may loosen what a bot may do is stamped over the bytes Spade receives", () => {
  const outside = json({ commands: "outside" });
  const open = json({ mode: "open", allow: [], dropped: [] });
  const grant = json({ kind: "folder", path: "/Users/me/app", write: true });
  const cases: [string, string, Buffer | undefined, unknown][] = [
    ["PUT", "/v1/agents/a_1/security/commands", outside, `commands:${sha(outside)}`],
    ["PUT", "/v1/security/commands", outside, `commands:${sha(outside)}`],
    ["PUT", "/v1/agents/a_1/security/network", open, `network:${sha(open)}`],
    ["PUT", "/v1/security/plugin-network", open, `plugin_network:${sha(open)}`],
    ["DELETE", "/v1/agents/a_1/security/network", undefined, "network:inherit"],
    ["DELETE", "/v1/agents/a_1/security/plugin-network", undefined, "plugin_network:inherit"],
    ["POST", "/v1/agents/a_1/grants", grant, `grant:${sha(grant)}`],
    [
      "PUT",
      "/v1/agents/a_1/connectors",
      json({ all: true }),
      `connectors:${sha(json({ all: true }))}`,
    ],
    [
      "PUT",
      "/v1/agents/a_1/package/effects",
      json({ key: "pay", on: true }),
      `package_effect:${sha(json({ key: "pay", on: true }))}`,
    ],
  ];
  for (const [method, path, body, value] of cases) {
    const target = path.startsWith("/v1/security") ? "machine" : "a_1";
    expect(personOnlyWrite(method, path, body), `${method} ${path}`).toEqual({
      target,
      value,
      optional: true,
    });
    // Sent in parts, it couldn't be read whole before it is stamped.
    expect(personOnlyRoute(method, path), `${method} ${path}`).toBeDefined();
  }
  // Reads, revoking a grant and routes that loosen nothing aren't stamped.
  for (const [method, path] of [
    ["GET", "/v1/agents/a_1/security/network"],
    ["DELETE", "/v1/agents/a_1/grants/g1"],
    ["DELETE", "/v1/agents/a_1/security/commands"],
    ["PUT", "/v1/agents/a_1/security/toolchains"],
  ] as const)
    expect(personOnlyWrite(method, path, json({})), `${method} ${path}`).toBeUndefined();
});
