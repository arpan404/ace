import { expect, it } from "vitest";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { HelloEarly } from "@ace/protocol";
import {
  NK_RETRY_MAX_MS,
  NK_RETRY_MS,
  RelayNkMemory,
  askNextTicket,
  earlyFlight,
} from "./relay-nk.ts";

// When a relay route opens with Noise NK and what it sends early (ADR 0155, step 2).

function memory() {
  const key = keyPair().publicKey;
  let now = 0;
  let wall = 1_700_000_000_000;
  const nk = new RelayNkMemory(fingerprint(key), { now: () => now, wallNow: () => wall });
  return {
    key,
    nk,
    advance: (ms: number) => (now += ms),
    jumpWall: (ms: number) => (wall += ms),
  };
}
const ticket = (n = 1) => ({ ticket: String(n).repeat(64).slice(0, 64), ttlMs: 60_000 });

it("NK is used only for a daemon that announced it under the pinned key, with a ticket or a grant in hand", () => {
  const { key, nk } = memory();
  nk.handed(ticket());
  expect(nk.attempt(undefined)).toBeUndefined();
  // Announced under another key: carries nothing, and replaces nothing.
  nk.welcomed(keyPair().publicKey, ["nk1"]);
  expect(nk.attempt(undefined)).toBeUndefined();
  nk.welcomed(key, ["nk1"]);
  nk.handed(ticket());
  expect(nk.attempt(undefined)).toEqual({ hostKey: key, ticket: ticket().ticket });
  // A ticket is one-use; a grant needs none.
  expect(nk.attempt(undefined)).toBeUndefined();
  expect(nk.attempt("grant")).toEqual({ hostKey: key });
  // A later welcome without the announcement turns it off.
  nk.welcomed(key, undefined);
  expect(nk.attempt("grant")).toBeUndefined();
});

it("a ticket is presented only while fresh by both the monotonic and the wall clock", () => {
  const { key, nk, advance, jumpWall } = memory();
  nk.welcomed(key, ["nk1"]);
  nk.handed(ticket());
  advance(56_000);
  expect(nk.attempt(undefined)).toBeUndefined();
  nk.handed(ticket());
  jumpWall(56_000);
  expect(nk.attempt(undefined)).toBeUndefined();
});

it("two NK failures in a row rest NK for 10 minutes, doubling to a day; one success resets it", () => {
  const { key, nk, advance } = memory();
  nk.welcomed(key, ["nk1"]);
  nk.failed();
  expect(nk.attempt("grant")).toBeDefined();
  nk.failed();
  expect(nk.attempt("grant")).toBeUndefined();
  advance(NK_RETRY_MS);
  expect(nk.attempt("grant")).toBeDefined();
  nk.failed();
  advance(NK_RETRY_MS);
  expect(nk.attempt("grant")).toBeUndefined();
  advance(NK_RETRY_MS);
  expect(nk.attempt("grant")).toBeDefined();
  for (let n = 0; n < 20; n++) nk.failed();
  advance(NK_RETRY_MAX_MS - 1);
  expect(nk.attempt("grant")).toBeUndefined();
  advance(1);
  expect(nk.attempt("grant")).toBeDefined();
  nk.succeeded();
  nk.failed();
  expect(nk.attempt("grant")).toBeDefined();
});

const hello = {
  type: "hello",
  protocolVersion: 1,
  deviceId: "phone",
  installId: "install-1",
  token: "device token",
  trims: ["item-defaults"],
  framing: ["lines"],
  flowControl: ["credit"],
};
const subscribe = (id: string, scope: unknown, extra: object = {}) =>
  JSON.stringify({ type: "subscribe", subscriptionId: id, scope, ...extra });

it("the first flight's hello and read subscribes go early; the token, install and anything else don't", () => {
  const thread = (n: number) => subscribe(`t${n}`, { kind: "thread", threadId: `thread-${n}` });
  const flight = [
    JSON.stringify(hello),
    ...[1, 2, 3, 4, 5].map(thread),
    subscribe("w1", { kind: "threads", window: { limit: 20 } }),
    subscribe("all", { kind: "threads" }),
    JSON.stringify({ type: "ping" }),
  ];
  const converted = earlyFlight(flight, { ticket: "ab".repeat(32) });
  expect(converted?.early).toMatchObject({
    type: "hello.early",
    deviceId: "phone",
    ticket: "ab".repeat(32),
    trims: ["item-defaults"],
    flowControl: ["credit"],
  });
  expect(JSON.stringify(converted?.early)).not.toContain("device token");
  expect(converted?.early.subscribes?.map((s) => s.subscriptionId)).toEqual([
    "t1",
    "t2",
    "t3",
    "t4",
    "w1",
  ]);
  expect(converted?.confirm).toEqual({
    type: "hello.confirm",
    installId: "install-1",
    nextTicket: true,
  });
  // The fifth thread, the unwindowed sidebar and the ping wait for after the confirmation.
  expect(converted?.rest).toEqual([
    thread(5),
    subscribe("all", { kind: "threads" }),
    '{"type":"ping"}',
  ]);
});

it("a dedicated channel or a machine code keeps XX, and a paired XX hello asks for the next ticket", () => {
  expect(
    earlyFlight([JSON.stringify({ ...hello, channel: "files" })], { ticket: "t" }),
  ).toBeUndefined();
  expect(
    earlyFlight([JSON.stringify({ ...hello, token: undefined, grant: "g", machineCode: "1234" })], {
      grant: "g",
    }),
  ).toBeUndefined();
  expect(JSON.parse(askNextTicket(JSON.stringify(hello)))).toMatchObject({ nextTicket: true });
  const account = JSON.stringify({ ...hello, token: undefined, grant: "g" });
  expect(askNextTicket(account)).toBe(account);
});

it("an account device's standing grant goes in its first message beside the grant, which alone goes to the relay", () => {
  const account = JSON.stringify({ ...hello, token: undefined, grant: "g.s", standing: "p.s" });
  const converted = earlyFlight([account], { grant: "g.s", standing: "p.s" });
  expect(converted?.early).toMatchObject({ grant: "g.s", standing: "p.s" });
  expect(HelloEarly.safeParse(converted?.early).success).toBe(true);
  // No standing grant without a grant: a paired device's ticket carries none.
  expect(
    earlyFlight([JSON.stringify(hello)], { ticket: "ab".repeat(32), standing: "p.s" })?.early,
  ).not.toHaveProperty("standing");
});
