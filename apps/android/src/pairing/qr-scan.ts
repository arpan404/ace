/**
 * QR capture session for the Android pairing screen.
 *
 * Mirrors the iOS `ScannerController` (`apps/ios/Sources/Views/Pairing/QRScannerView.swift`):
 * the camera hands decoded text back exactly once and never stores it; the
 * decoded string takes the same `acceptPairingText` parse path as pasted text,
 * so there is no second redemption path and nothing is ever transmitted
 * automatically — the one-use code is redeemed only on the explicit Pair
 * action through the injected `pair` callback. Validation of the link shape
 * happens downstream in `acceptPairingText`, never here: like iOS, the
 * scanner delivers the raw string and the entry state shows the parser's
 * actionable message for a malformed QR.
 *
 * Single delivery is the duplicate-redemption guard at this layer: the first
 * non-empty decode wins (`delivered`, as in iOS) and every later decode —
 * the same QR still in frame, a second QR, or a delayed callback after
 * cancel — is ignored. The session holds no link material after delivery
 * beyond the returned string, performs no networking, and never logs the
 * code or pin: all messages here are static copy.
 */

/** Shown when camera access is off; matches the iOS denial copy. */
export const QR_CAMERA_DENIED_MESSAGE =
  "Camera access is off. Allow it in Settings, or paste the link instead.";

/** Shown when the device has no usable camera; matches the iOS copy. */
export const QR_NO_CAMERA_MESSAGE = "No camera is available. Paste the pairing link instead.";

/**
 * Minimal camera-permission shape the scanner sheet branches on. Kept
 * structural (instead of importing `expo-camera` types) so the branching
 * stays pure and unit-testable without the native module.
 */
export interface QrCameraPermission {
  readonly status: "undetermined" | "granted" | "denied";
  readonly granted: boolean;
}

export type QrScannerState = "waiting" | "denied" | "no-camera" | "preview";

/**
 * Whether the visibility change is a fresh sheet opening that must reset
 * synchronously during render.
 *
 * Pure lifecycle rule for the `PairingQrScanner` reopen guard: resetting in
 * an effect runs after the first reopening render, so that render can mount
 * `CameraView` with the previous settled session (dropping a valid scan) and
 * stale availability. The component calls this during render and, on `true`,
 * replaces the session, clears the per-opening prompt flag, and drops the
 * cached availability before the preview branch is evaluated.
 */
export function isQrScannerOpening(prevVisible: boolean, visible: boolean): boolean {
  return !prevVisible && visible;
}

/**
 * Whether the sheet should fire the one-shot system permission prompt.
 *
 * Pure lifecycle rule for the `PairingQrScanner` request effect: `null`
 * (the `useCameraPermissions` hook still loading on first open) must not
 * prompt — the effect waits for the load to resolve, then prompts once
 * when it lands on `undetermined`. `alreadyRequested` is the per-opening
 * guard so the prompt fires at most once per sheet opening and never
 * loops when the grant/denial lands.
 */
export function shouldRequestCameraPermission(
  permission: QrCameraPermission | null,
  alreadyRequested: boolean,
): boolean {
  if (alreadyRequested) return false;
  return permission?.status === "undetermined";
}

/**
 * Whether returning to the app should re-read the camera permission and
 * re-probe the camera. Opening Settings backgrounds the app, so only a
 * foreground (`active`) transition while the sheet is open refreshes.
 */
export function shouldRefreshCameraOnAppActive(visible: boolean, appState: string): boolean {
  return visible && appState === "active";
}

/**
 * Branch the scanner sheet without touching native state.
 *
 * `undetermined` (or still loading as null) is *not* denial: the system
 * prompt has not been answered yet, so the sheet waits instead of showing
 * the "Camera is off" denial. Only an answered-but-ungranted permission
 * (`denied`) shows the denial with the Settings affordance. A granted
 * permission with unknown availability still waits for
 * `CameraView.isAvailableAsync`; only a granted `false` shows no-camera.
 */
export function resolveQrScannerState(
  permission: QrCameraPermission | null,
  cameraAvailable: boolean | null,
): QrScannerState {
  if (permission === null || permission.status === "undetermined") return "waiting";
  if (!permission.granted) return "denied";
  if (cameraAvailable === false) return "no-camera";
  if (cameraAvailable === true) return "preview";
  return "waiting";
}

export type QrScanResolution =
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "cancelled" };

export interface QrScanSession {
  /**
   * Offer a decoded QR string. Returns the resolution for the first
   * non-empty decode, or null when the decode is empty or a code was
   * already delivered (duplicate/after-cancel callbacks are dropped).
   */
  offer(text: string): QrScanResolution | null;
  /**
   * Cancel the scan. Returns the cancellation only when nothing was
   * delivered yet; after a code was delivered cancellation is a no-op
   * (null) so a burned confirmation is never silently dropped.
   */
  cancel(): QrScanResolution | null;
  readonly settled: boolean;
}

export function createQrScanSession(): QrScanSession {
  let settled = false;
  return {
    get settled() {
      return settled;
    },
    offer(text: string): QrScanResolution | null {
      if (settled || text.trim() === "") return null;
      settled = true;
      return { kind: "code", text };
    },
    cancel(): QrScanResolution | null {
      if (settled) return null;
      settled = true;
      return { kind: "cancelled" };
    },
  };
}
