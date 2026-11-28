import { expect, it } from "vitest";
import {
  accessSummary,
  fingerprintGroups,
  isPin,
  parseAndroidPairingLink,
  PairingLinkError,
} from "./pairing-link.ts";

const PIN = "9f".repeat(32);
const DIRECT = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const HOSTED =
  `https://app.acehq.dev/pair#host=https%3A%2F%2F192.168.1.20%3A4243` +
  `&code=abc123&fingerprint=${PIN}&scopes=read,operate`;

it("parses a direct pairing link without exposing the fragment to networking", () => {
  const link = parseAndroidPairingLink(DIRECT);
  expect(link.daemonOrigin).toBe("https://192.168.1.20:4243/");
  expect(link.socketUrl).toBe("wss://192.168.1.20:4243/");
  expect(link.displayHost).toBe("192.168.1.20:4243");
  expect(link.code).toBe("abc123");
  expect(link.fingerprint).toBe(PIN);
  expect(link.scopes).toEqual(["read", "operate"]);
  expect(link.daemonOrigin).not.toContain("#");
  expect(link.socketUrl).not.toContain("#");
  expect(link.socketUrl).not.toContain("abc123");
});

it("reads the computer address from a hosted-app link", () => {
  const link = parseAndroidPairingLink(HOSTED);
  expect(link.daemonOrigin).toBe("https://192.168.1.20:4243/");
  expect(link.socketUrl).toBe("wss://192.168.1.20:4243/");
  expect(link.displayHost).toBe("192.168.1.20:4243");
});

it("normalizes an uppercase fingerprint to the lowercase pin", () => {
  const link = parseAndroidPairingLink(
    `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN.toUpperCase()}`,
  );
  expect(link.fingerprint).toBe(PIN);
});

it("keeps a literal plus in the code, matching iOS fragment parsing", () => {
  const link = parseAndroidPairingLink(
    `https://192.168.1.20:4243/pair#code=ab%2Bc12%2Bd&fingerprint=${PIN}`,
  );
  expect(link.code).toBe("ab+c12+d");
});

it("measures link and code bounds in UTF-8 bytes, not UTF-16 units", () => {
  expect(() =>
    parseAndroidPairingLink(`https://h:1/pair#code=${"é".repeat(129)}&fingerprint=${PIN}`),
  ).toThrow(expect.objectContaining({ problem: "missing-code" }));
  expect(() => parseAndroidPairingLink(`https://h:1/pair#${"é".repeat(2049)}`)).toThrow(
    expect.objectContaining({ problem: "not-a-link" }),
  );
});

it("rejects cleartext links before anything is shown or sent", () => {
  try {
    parseAndroidPairingLink(DIRECT.replace("https:", "http:"));
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(PairingLinkError);
    expect((error as PairingLinkError).problem).toBe("insecure");
  }
});

it("rejects links with the wrong path, credentials or query strings", () => {
  for (const bad of [
    DIRECT.replace("/pair#", "/other#"),
    DIRECT.replace("https://", "https://user:pass@"),
    DIRECT.replace("/pair#", "/pair?x=1#"),
  ]) {
    expect(() => parseAndroidPairingLink(bad), bad).toThrow(PairingLinkError);
  }
});

it("rejects links without a code or without a valid pin", () => {
  expect(() => parseAndroidPairingLink(`https://h:1/pair#fingerprint=${PIN}`)).toThrow(
    expect.objectContaining({ problem: "missing-code" }),
  );
  expect(() =>
    parseAndroidPairingLink("https://h:1/pair#code=abc123&fingerprint=tooshort"),
  ).toThrow(expect.objectContaining({ problem: "invalid-pin" }));
  expect(() =>
    parseAndroidPairingLink("https://h:1/pair#code=abc123&fingerprint=zz".concat("0".repeat(62))),
  ).toThrow(expect.objectContaining({ problem: "invalid-pin" }));
});

it("rejects oversized links and non-links with an actionable message", () => {
  expect(() => parseAndroidPairingLink("nota link")).toThrow(
    expect.objectContaining({ problem: "not-a-link" }),
  );
  expect(() => parseAndroidPairingLink(`https://h:1/pair#${"x".repeat(4096)}`)).toThrow(
    PairingLinkError,
  );
  try {
    parseAndroidPairingLink("nota link");
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toContain("ace pair");
    expect((error as Error).message).not.toContain("nota link");
  }
});

it("accepts only 64 lowercase hex pins", () => {
  expect(isPin(PIN)).toBe(true);
  expect(isPin(PIN.toUpperCase())).toBe(false);
  expect(isPin("9f".repeat(31))).toBe(false);
  expect(isPin("")).toBe(false);
});

it("groups fingerprints in fours for screen comparison", () => {
  expect(fingerprintGroups("0123456789abcdef")).toBe("0123 4567 89ab cdef");
  expect(fingerprintGroups(PIN).split(" ")).toHaveLength(16);
});

it("summarizes the host-chosen grant without implying more access", () => {
  expect(accessSummary([])).toBe("Chosen by your computer");
  expect(accessSummary(["read"])).toBe("View only");
  expect(accessSummary(["read", "operate"])).toBe("View and act");
  expect(accessSummary(["admin"])).toBe("Administrator");
  expect(accessSummary(["read", "operate", "projects", "accounts"])).toBe(
    "View and act · Projects · Accounts",
  );
});
