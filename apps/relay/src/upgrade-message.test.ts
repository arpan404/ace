import { expect, it } from "vitest";
import {
  NK_UPGRADE_MESSAGE,
  decodeFirstMessage,
  UPGRADE_MESSAGE,
  takenUpgradeMessage,
  upgradeMessage,
} from "./early-frame.ts";

// What a relay takes from an upgrade request as the client's first message (ADR 0155, step 3):
// only something that can be one, the 32-byte XX first message, in canonical unpadded
// base64url; anything else is as if the entry were absent.

const key = new Uint8Array(32).map((_, i) => i + 1);
const entry = (text: string) => UPGRADE_MESSAGE.prefix + text;
const offer = (...entries: string[]) => [UPGRADE_MESSAGE.subprotocol, ...entries].join(", ");
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

it("the 32-byte first message, 43 characters, is taken", () => {
  expect(encoded(key)).toHaveLength(43);
  expect(upgradeMessage(offer(entry(encoded(key))))).toEqual(Buffer.from(key));
});

it.each([
  ["1 byte", entry(encoded(new Uint8Array(1)))],
  ["31 bytes", entry(encoded(new Uint8Array(31)))],
  ["33 bytes", entry(encoded(new Uint8Array(33)))],
  [
    "padded",
    entry(`${Buffer.from(key).toString("base64")}`.replaceAll("+", "-").replaceAll("/", "_")),
  ],
  ["a non-canonical encoding", entry(`${encoded(key).slice(0, 42)}B`)],
  ["empty", entry("")],
  ["not base64url", entry("!".repeat(43))],
])("an entry of %s is as if it were absent", (_name, bad) => {
  expect(upgradeMessage(offer(bad))).toBeUndefined();
});

it("without ace.v2, or with two entries, nothing is taken", () => {
  expect(upgradeMessage(entry(encoded(key)))).toBeUndefined();
  expect(
    upgradeMessage(offer(entry(encoded(key)), entry(encoded(new Uint8Array(32))))),
  ).toBeUndefined();
});

// With step 2: an NK first message in the upgrade, under its own entry and rule.

const nkEntry = (bytes: Uint8Array) => NK_UPGRADE_MESSAGE.prefix + encoded(bytes);
const both = (...entries: string[]) =>
  [NK_UPGRADE_MESSAGE.subprotocol, UPGRADE_MESSAGE.subprotocol, ...entries].join(", ");

it("an NK first message of 48 to 3,066 bytes is taken and answered with ace.v3, ahead of an XX one", () => {
  for (const size of [NK_UPGRADE_MESSAGE.minBytes, 600, NK_UPGRADE_MESSAGE.maxBytes]) {
    const message = new Uint8Array(size).fill(3);
    expect(takenUpgradeMessage(both(nkEntry(message), entry(encoded(key))))).toEqual({
      message: Buffer.from(message),
      echo: NK_UPGRADE_MESSAGE.subprotocol,
    });
  }
  // The largest fits the 4 KiB entry.
  expect(nkEntry(new Uint8Array(NK_UPGRADE_MESSAGE.maxBytes)).length).toBeLessThanOrEqual(
    UPGRADE_MESSAGE.entryBytes,
  );
});

it.each([
  ["47 bytes", new Uint8Array(47)],
  ["over the maximum", new Uint8Array(NK_UPGRADE_MESSAGE.maxBytes + 1)],
])("an NK entry of %s isn't taken: an XX entry beside it is", (_name, bytes) => {
  expect(takenUpgradeMessage(both(nkEntry(bytes), entry(encoded(key))))).toEqual({
    message: Buffer.from(key),
    echo: UPGRADE_MESSAGE.subprotocol,
  });
});

it("an NK entry is ignored without ace.v3, and a relay that knows only XX's entry never reads it", () => {
  const nk = nkEntry(new Uint8Array(100).fill(1));
  expect(takenUpgradeMessage(offer(nk, entry(encoded(key))))?.echo).toBe(
    UPGRADE_MESSAGE.subprotocol,
  );
  expect(takenUpgradeMessage(offer(nk))).toBeUndefined();
  // XX's own rule (what a step-3-only relay runs) takes nothing from it.
  expect(upgradeMessage(both(nk))).toBeUndefined();
});

it.each([
  [
    "padded",
    `${NK_UPGRADE_MESSAGE.prefix}${Buffer.from(new Uint8Array(100)).toString("base64").replaceAll("+", "-").replaceAll("/", "_")}`,
  ],
  ["non-canonical", `${nkEntry(new Uint8Array(100)).slice(0, -1)}B`],
  ["empty", NK_UPGRADE_MESSAGE.prefix],
])("a %s NK entry is as if it were absent", (_name, bad) => {
  expect(takenUpgradeMessage(both(bad))).toBeUndefined();
});

it("a first message is decoded once, into a buffer of its own that wiping clears entirely", () => {
  const text = encoded(new Uint8Array(400).fill(9));
  const message = decodeFirstMessage(text, 48, 3066);
  if (!message) throw new Error("Not taken");
  // Its own memory, exactly its length: no pooled slab another copy could share.
  expect(message.byteOffset).toBe(0);
  expect(message.buffer.byteLength).toBe(400);
  message.fill(0);
  expect(new Uint8Array(message.buffer).every((byte) => byte === 0)).toBe(true);
  // Canonical form is checked on the text: unused trailing bits set are refused.
  // 49 and 50 bytes end in a partial group, whose last character has bits past the data.
  for (const size of [49, 50])
    expect(
      decodeFirstMessage(`${encoded(new Uint8Array(size)).slice(0, -1)}B`, 1, 3066),
    ).toBeUndefined();
});
