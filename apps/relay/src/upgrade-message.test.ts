import { expect, it } from "vitest";
import { UPGRADE_MESSAGE, upgradeMessage } from "./early-frame.ts";

// What a relay takes from an upgrade request as the client's first message (ADR 0155, step 3):
// only something that can be one, the 32-byte XX first message, in canonical unpadded
// base64url; anything else is as if the entry were absent.

const key = new Uint8Array(32).map((_, i) => i + 1);
const entry = (text: string) => UPGRADE_MESSAGE.prefix + text;
const offer = (...entries: string[]) => [UPGRADE_MESSAGE.subprotocol, ...entries].join(", ");
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

it("the 32-byte first message, 43 characters, is taken", () => {
  expect(encoded(key)).toHaveLength(43);
  expect(upgradeMessage(offer(entry(encoded(key))))).toEqual(key);
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
