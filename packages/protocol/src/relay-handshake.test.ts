import { expect, it } from "vitest";
import { HelloConfirm, HelloEarly } from "./relay-handshake.ts";

// What a relay NK first message may carry (ADR 0155, step 2): the allowlist, and nothing that
// acts on the device, since a recorder can replay it.

const ticket = "ab".repeat(32);
const valid = {
  type: "hello.early",
  protocolVersion: 1,
  deviceId: "phone",
  ticket,
  trims: ["item-defaults"],
  framing: ["lines"],
  compression: ["deflate-raw"],
  flowControl: ["credit"],
  subscribes: [
    { subscriptionId: "t1", scope: { kind: "thread", threadId: "thread-1" }, afterSeq: 4 },
    { subscriptionId: "w1", scope: { kind: "threads", window: { limit: 20 } }, paced: true },
  ],
};

it("a first message with the allowlisted fields is taken", () => {
  expect(HelloEarly.safeParse(valid).success).toBe(true);
  const { ticket: _ticket, ...withGrant } = valid;
  expect(HelloEarly.safeParse({ ...withGrant, grant: "grant" }).success).toBe(true);
});

it.each([
  ["token", { token: "device token" }],
  ["machineCode", { machineCode: "1234" }],
  ["link", { link: { deviceId: "phone", proof: "a".repeat(43) } }],
  ["installId", { installId: "install-1" }],
  ["channel", { channel: "files" }],
  ["nextTicket", { nextTicket: true }],
  ["mediaTicket", { mediaTicket: "m".repeat(43) }],
  ["presence", { presence: { state: "active" } }],
  ["notification preferences", { notifications: { enabled: true } }],
  ["read markers", { reads: { "thread-1": 4 } }],
  ["settings", { settings: { theme: "dark" } }],
  ["a command", { command: { type: "thread.send" } }],
  ["an outbox replay", { outbox: [{ type: "command" }] }],
  ["a hello type", { type: "hello" }],
])("a first message carrying %s is refused", (_name, extra) => {
  expect(HelloEarly.safeParse({ ...valid, ...extra }).success).toBe(false);
});

it.each([
  ["no credential", { ticket: undefined }],
  ["both a ticket and a grant", { grant: "grant" }],
  ["a ticket that isn't one", { ticket: "not a ticket" }],
  [
    "five thread subscribes",
    {
      subscribes: Array.from({ length: 5 }, (_, n) => ({
        subscriptionId: `t${n}`,
        scope: { kind: "thread", threadId: `thread-${n}` },
      })),
    },
  ],
  [
    "three sidebar windows",
    {
      subscribes: Array.from({ length: 3 }, (_, n) => ({
        subscriptionId: `w${n}`,
        scope: { kind: "threads", window: { limit: 5 } },
      })),
    },
  ],
  [
    "a repeated subscription id",
    {
      subscribes: [
        { subscriptionId: "a", scope: { kind: "thread", threadId: "thread-1" } },
        { subscriptionId: "a", scope: { kind: "thread", threadId: "thread-2" } },
      ],
    },
  ],
  [
    "a sidebar subscribe without its window",
    { subscribes: [{ subscriptionId: "w", scope: { kind: "threads" } }] },
  ],
  [
    "a subscribe with a field subscribes don't have",
    {
      subscribes: [
        { subscriptionId: "a", scope: { kind: "thread", threadId: "thread-1" }, markRead: true },
      ],
    },
  ],
])("a first message with %s is refused", (_name, change) => {
  expect(HelloEarly.safeParse({ ...valid, ...change }).success).toBe(false);
});

it("the confirmation carries the device-acting fields, and nothing else", () => {
  expect(
    HelloConfirm.safeParse({
      type: "hello.confirm",
      installId: "install-1",
      link: { deviceId: "phone", proof: "a".repeat(43) },
      nextTicket: true,
    }).success,
  ).toBe(true);
  expect(HelloConfirm.safeParse({ type: "hello.confirm" }).success).toBe(true);
  for (const extra of [{ token: "device token" }, { ticket }, { command: {} }])
    expect(HelloConfirm.safeParse({ type: "hello.confirm", ...extra }).success).toBe(false);
});

/** Every object in `value`, by path, with the value at it. */
function objects(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value !== "object" || value === null) return [];
  const nested = Object.entries(value).flatMap(([key, child]) =>
    objects(child, [...path, Array.isArray(value) ? Number(key) : key]),
  );
  return Array.isArray(value) ? nested : [path, ...nested];
}

function withKey(value: unknown, path: (string | number)[], key: string): unknown {
  const copy: unknown = structuredClone(value);
  let target = copy as Record<string | number, unknown>;
  for (const step of path) target = target[step] as Record<string | number, unknown>;
  target[key] = "x";
  return copy;
}

// Every object the early payload may hold, each field present.
const full = {
  ...valid,
  subscribes: [
    {
      subscriptionId: "t1",
      scope: { kind: "thread", threadId: "thread-1" },
      afterSeq: 4,
      paced: true,
      tail: { items: 20, bytes: 4096 },
    },
    {
      subscriptionId: "w1",
      scope: { kind: "threads", window: { limit: 20, project: "p", archived: false } },
    },
  ],
};

it("the fully populated first message is taken", () => {
  expect(HelloEarly.safeParse(full).success).toBe(true);
});

it.each(objects(full).map((path) => [path.join(".") || "(top)", path] as const))(
  "an unknown key in the first message at %s is refused",
  (_name, path) => {
    for (const key of ["token", "machineCode", "unknown"])
      expect(HelloEarly.safeParse(withKey(full, path, key)).success).toBe(false);
  },
);
