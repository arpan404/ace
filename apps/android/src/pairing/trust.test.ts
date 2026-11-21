import { expect, it } from "vitest";
import { decideTrust, isPin, isTailnetName, TrustError } from "../security/trust.ts";

const PIN = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const WINDOW = { notBeforeMs: 1_700_000_000_000, notAfterMs: 1_800_000_000_000 };
const NOW = 1_750_000_000_000;

function input(overrides: Partial<Parameters<typeof decideTrust>[0]> = {}) {
  return {
    actualPin: PIN,
    expectedPin: PIN,
    host: "192.168.1.20",
    nowMs: NOW,
    ...WINDOW,
    systemTrusts: () => {
      throw new Error("system trust must not be consulted when the pin matches");
    },
    ...overrides,
  };
}

it("trusts the exact pinned key inside its validity window", () => {
  expect(() => decideTrust(input())).not.toThrow();
});

it("rejects a changed pin before any credential leaves", () => {
  try {
    decideTrust(input({ actualPin: OTHER, systemTrusts: () => true }));
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(TrustError);
    expect((error as TrustError).failure).toBe("mismatch");
  }
});

it("accepts a publicly trusted certificate only for the exact ts.net name", () => {
  expect(() =>
    decideTrust(input({ actualPin: OTHER, host: "mac.tail0.ts.net", systemTrusts: () => true })),
  ).not.toThrow();
  expect(() =>
    decideTrust(input({ actualPin: OTHER, host: "mac.tail0.ts.net", systemTrusts: () => false })),
  ).toThrow(expect.objectContaining({ failure: "mismatch" }));
  expect(() =>
    decideTrust(input({ actualPin: OTHER, host: "192.168.1.20", systemTrusts: () => true })),
  ).toThrow(expect.objectContaining({ failure: "mismatch" }));
});

it("rejects expired and not-yet-valid certificates even with system trust", () => {
  expect(() =>
    decideTrust(
      input({ nowMs: WINDOW.notAfterMs, host: "mac.tail0.ts.net", systemTrusts: () => true }),
    ),
  ).toThrow(expect.objectContaining({ failure: "expired" }));
  expect(() =>
    decideTrust(input({ nowMs: WINDOW.notBeforeMs - 1, systemTrusts: () => false })),
  ).toThrow(expect.objectContaining({ failure: "expired" }));
});

it("rejects malformed pins and windows without consulting system trust", () => {
  for (const bad of [
    input({ actualPin: "short" }),
    input({ expectedPin: PIN.toUpperCase() }),
    input({ notBeforeMs: WINDOW.notAfterMs + 1 }),
  ]) {
    expect(() => decideTrust(bad)).toThrow(expect.objectContaining({ failure: "malformed" }));
  }
});

it("recognizes only Tailscale MagicDNS names for the trust exception", () => {
  expect(isTailnetName("mac.tail0.ts.net")).toBe(true);
  expect(isTailnetName("MAC.TAIL0.TS.NET.")).toBe(true);
  expect(isTailnetName("ts.net")).toBe(false);
  expect(isTailnetName("example.com")).toBe(false);
  expect(isTailnetName("100.64.0.1")).toBe(false);
  expect(isTailnetName("mac.ts.net.evil.com")).toBe(false);
});

it("accepts only 64 lowercase hex pins", () => {
  expect(isPin(PIN)).toBe(true);
  expect(isPin(OTHER.toUpperCase())).toBe(false);
  expect(isPin("")).toBe(false);
});
