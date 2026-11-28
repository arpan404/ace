import { expect, it } from "vitest";
import { PairingFlowError } from "./pairing-flow.ts";
import {
  PAIRING_FAILED_MESSAGE,
  PAIRING_UNAVAILABLE_MESSAGE,
  SCAN_FAILED_MESSAGE,
  acceptPairingText,
  canStartPairing,
  pairingFailureMessage,
} from "./pairing-view.ts";

const PIN = "9f".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;

it("accepts a pasted link into the confirmation the person checks before anything is sent", () => {
  const accepted = acceptPairingText(LINK);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.confirmed.displayHost).toBe("192.168.1.20:4243");
  expect(accepted.confirmed.accessSummary).toBe("View and act");
  expect(accepted.confirmed.fingerprintGroups).toBe(
    "9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f 9f9f",
  );
  expect(accepted.confirmed.link.code).toBe("abc123");
});

it("accepts a scanned named-host link through the same single parse path", () => {
  const named =
    `https://app.acehq.dev/pair#` +
    `host=${encodeURIComponent("https://studio.tailnet.ts.net:7417")}` +
    `&code=qr-code-1&fingerprint=${PIN}&scopes=admin`;
  const accepted = acceptPairingText(named);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.confirmed.displayHost).toBe("studio.tailnet.ts.net:7417");
  expect(accepted.confirmed.accessSummary).toBe("Administrator");
});

it("rejects pasted text with an actionable message that carries no link material", () => {
  const accepted = acceptPairingText("nota link");
  expect(accepted.ok).toBe(false);
  if (accepted.ok) return;
  expect(accepted.entryError).toContain("ace pair");
});

it("rejects a tampered link without echoing its code or pin", () => {
  const secret = "supersecretcode99";
  const accepted = acceptPairingText(`https://192.168.1.20:4243/pair#code=${secret}`);
  expect(accepted.ok).toBe(false);
  if (accepted.ok) return;
  expect(accepted.entryError).not.toContain(secret);
  expect(accepted.entryError).not.toContain(PIN);
});

it("gates the Pair action on a non-blank device name and no pair in flight", () => {
  expect(canStartPairing("My phone", false)).toBe(true);
  expect(canStartPairing("   ", false)).toBe(false);
  expect(canStartPairing("", false)).toBe(false);
  expect(canStartPairing("My phone", true)).toBe(false);
});

it("keeps fail-closed copy actionable without promising a send", () => {
  expect(PAIRING_UNAVAILABLE_MESSAGE).toContain("nothing was sent");
});

it("shows mapped pairing copy and never raw scanner or transport text", () => {
  const mapped = new PairingFlowError(
    "consumed",
    "Pairing used this link but did not finish. Check the computer's devices for an unused entry and remove it, then create a new link.",
  );
  expect(pairingFailureMessage(mapped)).toBe(mapped.message);
  const secret = "supersecretcode99";
  const leak = new Error(`camera failed on ${secret} with pin ${PIN}`);
  expect(pairingFailureMessage(leak)).toBe(PAIRING_FAILED_MESSAGE);
  expect(pairingFailureMessage(leak)).not.toContain(secret);
  expect(pairingFailureMessage(leak)).not.toContain(PIN);
  expect(pairingFailureMessage("plain string")).toBe(PAIRING_FAILED_MESSAGE);
  expect(pairingFailureMessage(null)).toBe(PAIRING_FAILED_MESSAGE);
  expect(SCAN_FAILED_MESSAGE).toContain("Paste the pairing link instead");
  expect(SCAN_FAILED_MESSAGE).not.toContain(secret);
});
