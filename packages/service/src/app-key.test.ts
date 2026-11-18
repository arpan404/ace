import { describe, expect, it } from "vitest";
import { appKeyLine, appSocketProof, appSocketProven, parseAppKeyLine } from "./app-key.ts";

const key = new Uint8Array(32).fill(3);

describe("the desktop app's proof for its page's socket", () => {
  it("verifies at the port it was made for", () => {
    expect(appSocketProven(key, 4242, appSocketProof(key, 4242))).toBe(true);
  });

  it("is worthless at any other port, so a listener at another address can't reuse it", () => {
    expect(appSocketProven(key, 4243, appSocketProof(key, 4242))).toBe(false);
  });

  it("doesn't verify when made with another key", () => {
    expect(appSocketProven(key, 4242, appSocketProof(new Uint8Array(32), 4242))).toBe(false);
  });

  it("doesn't verify a malformed proof", () => {
    expect(appSocketProven(key, 4242, "")).toBe(false);
    expect(appSocketProven(key, 4242, "not a proof")).toBe(false);
  });
});

describe("the key line the app writes on the daemon's stdin", () => {
  it("reads back as the key the app wrote", () => {
    expect(parseAppKeyLine(appKeyLine(key))).toEqual(key);
  });

  it.each([
    ["nothing", ""],
    ["a short key", "ab".repeat(31) + "\n"],
    ["uppercase hex", "AB".repeat(32) + "\n"],
    ["a second line", "ab".repeat(32) + "\nmore\n"],
  ])("gives no key for %s", (_what, text) => {
    expect(parseAppKeyLine(text)).toBeUndefined();
  });
});
