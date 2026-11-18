import { describe, expect, it } from "vitest";
import { clientOf, featureGate, parseClient } from "./client-features.ts";

/** A feature first shipped in the 0.0.24 betas on desktop and daemon, and in iPhone 1.3.0. */
const table = {
  shared: { desktop: "0.0.24-beta.1", daemon: "0.0.24-beta.1", ios: "1.3.0" },
  stableOnly: { desktop: "0.0.25" },
} as const;
const supports = (value: string | null, feature: keyof typeof table) =>
  featureGate(table, parseClient(value)).supports(feature);

describe("a gated feature", () => {
  it.each([
    ["desktop/0.0.23", false],
    ["desktop/0.0.24-beta.1", true],
    ["desktop/0.0.24-beta.2", true],
    ["desktop/0.0.24-beta.10", true],
    ["desktop/0.0.24", true],
    ["desktop/0.1.0", true],
    ["daemon/0.0.24-beta.3", true],
    ["daemon/0.0.23", false],
    ["ios/1.2.9", false],
    ["ios/1.3.0", true],
  ])("for %s is on: %s", (value, on) => {
    expect(supports(value, "shared")).toBe(on);
  });

  it("stays off for a beta of the version that introduces it in stable", () => {
    expect(supports("desktop/0.0.25-beta.4", "stableOnly")).toBe(false);
    expect(supports("desktop/0.0.25", "stableOnly")).toBe(true);
  });

  it("stays off for an app the feature names no minimum for", () => {
    expect(supports("web/9.9.9", "shared")).toBe(false);
    expect(supports("cli/development", "shared")).toBe(false);
  });

  it("is on for a development build of an app that has it", () => {
    expect(supports("desktop/development", "shared")).toBe(true);
    expect(supports("ios/development", "shared")).toBe(true);
  });

  it.each([
    null,
    "",
    "desktop",
    "desktop/",
    "desktop/latest",
    "desktop/0.0.24 beta",
    "desktop/v0.0.24",
    "android/9.9.9",
    "Desktop/0.0.24",
    `desktop/0.0.24-beta.${"1".repeat(100)}`,
  ])("is off for a missing or garbled client %j, treated as the oldest app", (value) => {
    expect(supports(value, "shared")).toBe(false);
  });
});

const request = (url: string, headers: Record<string, string> = {}) => ({
  url,
  headers: new Headers(headers),
});

describe("reading the caller", () => {
  it("reads the ace-client header", () => {
    expect(
      clientOf(request("https://cloud.test/v1/me", { "ace-client": "daemon/0.0.24-beta.1" })),
    ).toEqual({ kind: "release", app: "daemon", version: "0.0.24-beta.1" });
  });

  it("reads the query parameter a browser names itself with, on upgrades and plain requests", () => {
    for (const url of [
      "https://relay.test/client?hostId=h&ace-client=web%2F0.0.24",
      "https://cloud.test/v1/account/session?ace-client=web%2F0.0.24",
    ])
      expect(clientOf(request(url))).toEqual({ kind: "release", app: "web", version: "0.0.24" });
  });

  it("lets a present header win over the URL, even a garbled one", () => {
    expect(
      clientOf(request("https://relay.test/client?ace-client=web%2F0.0.24", { "ace-client": "x" })),
    ).toEqual({ kind: "unknown" });
  });

  it("names an older app that sends neither as unknown", () => {
    expect(clientOf(request("https://market.test/v1/bots"))).toEqual({ kind: "unknown" });
  });
});
