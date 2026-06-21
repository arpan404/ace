import { describe, expect, it } from "vitest";

import { findDesktopPairingUrlInArgv, normalizeDesktopPairingUrl } from "./pairingProtocol";

describe("normalizeDesktopPairingUrl", () => {
  it("accepts ace pairing urls", () => {
    expect(normalizeDesktopPairingUrl("ace://pair?p=abc")).toBe("ace://pair?p=abc");
  });

  it("rejects non-pair ace urls", () => {
    expect(normalizeDesktopPairingUrl("ace://app/index.html")).toBeNull();
  });

  it("rejects non-ace urls", () => {
    expect(normalizeDesktopPairingUrl("https://example.com")).toBeNull();
  });
});

describe("findDesktopPairingUrlInArgv", () => {
  it("returns the first pairing url in argv", () => {
    expect(
      findDesktopPairingUrlInArgv(["--flag", "ace://pair?p=first", "ace://pair?p=second"]),
    ).toBe("ace://pair?p=first");
  });

  it("returns null when argv does not contain a pairing url", () => {
    expect(findDesktopPairingUrlInArgv(["--flag", "ace://app/index.html"])).toBeNull();
  });
});
