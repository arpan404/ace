import { expect, it } from "vitest";
import {
  QR_CAMERA_DENIED_MESSAGE,
  QR_NO_CAMERA_MESSAGE,
  createQrScanSession,
  isQrScannerOpening,
  resolveQrScannerState,
  shouldRefreshCameraOnAppActive,
  shouldRequestCameraPermission,
} from "./qr-scan.ts";
import { acceptPairingText } from "./pairing-view.ts";

const PIN = "9f".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;

it("delivers the first decode once and ignores later duplicates", () => {
  const session = createQrScanSession();
  const first = session.offer(LINK);
  expect(first).toEqual({ kind: "code", text: LINK });
  expect(session.settled).toBe(true);
  expect(session.offer(LINK)).toBeNull();
  expect(session.offer("https://other.example/pair#code=x")).toBeNull();
  expect(session.cancel()).toBeNull();
});

it("ignores empty decodes without settling", () => {
  const session = createQrScanSession();
  expect(session.offer("")).toBeNull();
  expect(session.offer("   \n  ")).toBeNull();
  expect(session.settled).toBe(false);
  expect(session.offer(LINK)?.kind).toBe("code");
});

it("cancels only before a code is delivered", () => {
  const pending = createQrScanSession();
  expect(pending.cancel()).toEqual({ kind: "cancelled" });
  expect(pending.settled).toBe(true);
  expect(pending.offer(LINK)).toBeNull();
  expect(pending.cancel()).toBeNull();
});

it("delivers malformed QR text once for the shared parse path to reject", () => {
  const session = createQrScanSession();
  const delivered = session.offer("nota link");
  expect(delivered?.kind).toBe("code");
  if (delivered?.kind !== "code") return;
  const accepted = acceptPairingText(delivered.text);
  expect(accepted.ok).toBe(false);
  if (accepted.ok) return;
  expect(accepted.entryError).toContain("ace pair");
  expect(accepted.entryError).not.toContain("nota link");
});

it("accepts a scanned link through the same confirmation as pasted text", () => {
  const session = createQrScanSession();
  const delivered = session.offer(LINK);
  expect(delivered?.kind).toBe("code");
  if (delivered?.kind !== "code") return;
  const accepted = acceptPairingText(delivered.text);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.confirmed.link.code).toBe("abc123");
  expect(accepted.confirmed.displayHost).toBe("192.168.1.20:4243");
});

it("keeps denial and no-camera copy static with paste guidance", () => {
  const secret = "supersecretcode99";
  expect(QR_CAMERA_DENIED_MESSAGE).toContain("Settings");
  expect(QR_CAMERA_DENIED_MESSAGE).toContain("paste the link instead");
  expect(QR_NO_CAMERA_MESSAGE).toContain("Paste the pairing link instead");
  expect(QR_CAMERA_DENIED_MESSAGE).not.toContain(secret);
  expect(QR_NO_CAMERA_MESSAGE).not.toContain(secret);
  expect(QR_CAMERA_DENIED_MESSAGE).not.toContain(PIN);
});

it("waits while the permission is still loading instead of showing denial", () => {
  expect(resolveQrScannerState(null, null)).toBe("waiting");
  expect(resolveQrScannerState(null, false)).toBe("waiting");
});

it("waits while the permission is undetermined instead of showing denial", () => {
  expect(resolveQrScannerState({ status: "undetermined", granted: false }, null)).toBe("waiting");
  expect(resolveQrScannerState({ status: "undetermined", granted: false }, false)).toBe("waiting");
});

it("shows denial only after the prompt is answered without a grant", () => {
  expect(resolveQrScannerState({ status: "denied", granted: false }, null)).toBe("denied");
  expect(resolveQrScannerState({ status: "denied", granted: false }, true)).toBe("denied");
});

it("waits for the camera probe after a grant, then branches on availability", () => {
  expect(resolveQrScannerState({ status: "granted", granted: true }, null)).toBe("waiting");
  expect(resolveQrScannerState({ status: "granted", granted: true }, false)).toBe("no-camera");
  expect(resolveQrScannerState({ status: "granted", granted: true }, true)).toBe("preview");
});

it("waits while the hook is still loading, then prompts once it resolves to undetermined", () => {
  // First open: the effect runs with null before the async load lands.
  expect(shouldRequestCameraPermission(null, false)).toBe(false);
  // The null → undetermined transition is the prompt trigger.
  expect(shouldRequestCameraPermission({ status: "undetermined", granted: false }, false)).toBe(
    true,
  );
});

it("prompts at most once per opening and never after an answer", () => {
  expect(shouldRequestCameraPermission({ status: "undetermined", granted: false }, true)).toBe(
    false,
  );
  expect(shouldRequestCameraPermission({ status: "granted", granted: true }, false)).toBe(false);
  expect(shouldRequestCameraPermission({ status: "denied", granted: false }, false)).toBe(false);
});

it("refreshes the permission and camera probe only on foreground with the sheet open", () => {
  expect(shouldRefreshCameraOnAppActive(true, "active")).toBe(true);
  expect(shouldRefreshCameraOnAppActive(true, "background")).toBe(false);
  expect(shouldRefreshCameraOnAppActive(true, "inactive")).toBe(false);
  expect(shouldRefreshCameraOnAppActive(false, "active")).toBe(false);
});

it("resets synchronously only on the closed → open edge", () => {
  // Reopen after close must reset before the first render mounts CameraView.
  expect(isQrScannerOpening(false, true)).toBe(true);
  // Staying open, staying closed, or closing never resets.
  expect(isQrScannerOpening(true, true)).toBe(false);
  expect(isQrScannerOpening(false, false)).toBe(false);
  expect(isQrScannerOpening(true, false)).toBe(false);
});

it("delivers a valid scan after reopen even when the previous session settled", () => {
  // First opening settles (scan delivered, then sheet closes).
  const first = createQrScanSession();
  expect(first.offer(LINK)?.kind).toBe("code");
  // A late duplicate after settle is dropped, as on the closed sheet.
  expect(first.offer(LINK)).toBeNull();
  // Reopen replaces the session synchronously, so the same valid QR
  // delivers again instead of being dropped as a duplicate.
  const reopened = createQrScanSession();
  expect(reopened.settled).toBe(false);
  const delivered = reopened.offer(LINK);
  expect(delivered?.kind).toBe("code");
  if (delivered?.kind !== "code") return;
  expect(delivered.text).toBe(LINK);
});
