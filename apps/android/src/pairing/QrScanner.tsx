import { useEffect, useState } from "react";
import { AppState, Linking, Modal, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { AceButton } from "../components.tsx";
import { AceHost, tokens, useTheme, textStyle } from "../theme.tsx";
import {
  QR_CAMERA_DENIED_MESSAGE,
  QR_NO_CAMERA_MESSAGE,
  createQrScanSession,
  isQrScannerOpening,
  resolveQrScannerState,
  shouldRefreshCameraOnAppActive,
  shouldRequestCameraPermission,
  type QrScanSession,
} from "./qr-scan.ts";

/**
 * Live camera QR sheet for the Android pairing screen.
 *
 * Mirrors the iOS `QRScannerView` sheet (`apps/ios/Sources/Views/Pairing/QRScannerView.swift`):
 * a full-screen preview restricted to QR codes hands the decoded text back
 * exactly once and never stores it; cancellation, denial and a missing
 * camera all close the sheet without sending anything. The decoded string
 * takes the same `acceptPairingText` parse path as pasted text, so a
 * malformed QR cannot transmit and an invalid scan surfaces the parser's
 * actionable entry error on the entry screen.
 *
 * Single delivery uses the shared `createQrScanSession` guard (the iOS
 * `delivered` flag): the first non-empty decode wins and every later
 * decode — the same QR still in frame or a delayed callback after
 * cancel — is dropped, so one scan can never confirm twice. An
 * `undetermined` permission waits for the system prompt instead of
 * showing denial, and returning from Settings re-reads the permission
 * and re-probes the camera via the `AppState` refresh below.
 */
export function PairingQrScanner({
  visible,
  onScanned,
  onCancel,
  onDenied,
}: {
  visible: boolean;
  /** First decoded QR text. Called at most once per opening. */
  onScanned(text: string): void;
  /** The person cancelled with nothing delivered. */
  onCancel(): void;
  /** Permission denied or no camera; the message is safe static copy to show as the entry error. */
  onDenied(message: string): void;
}) {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [cameraAvailable, setCameraAvailable] = useState<boolean | null>(null);
  const [prevVisible, setPrevVisible] = useState(visible);
  const [scanSession, setScanSession] = useState<QrScanSession>(() => createQrScanSession());
  const [promptRequested, setPromptRequested] = useState(false);
  // Synchronous per-opening reset: the previous effect-based reset ran after
  // the first reopening render, so that render could mount `CameraView` with
  // the settled session (a valid scan is dropped by `offer`) and stale
  // `cameraAvailable`. Adjusting state during render re-renders before commit,
  // so the first reopening render already sees a fresh session and a cleared
  // probe cache and never mounts the preview from stale state.
  if (isQrScannerOpening(prevVisible, visible)) {
    setPrevVisible(visible);
    setScanSession(createQrScanSession());
    setPromptRequested(false);
    if (cameraAvailable !== null) setCameraAvailable(null);
  } else if (prevVisible !== visible) {
    setPrevVisible(visible);
  }
  const theme = useTheme();

  // First open: `useCameraPermissions` mounts as null, then resolves
  // async to `undetermined`. Keying on the status (not just `visible`)
  // catches that null → undetermined transition so the system prompt is
  // never skipped; the per-opening flag keeps it to one prompt.
  useEffect(() => {
    if (!visible) return;
    const shaped =
      permission == null
        ? null
        : {
            status:
              permission.status === "granted" || permission.status === "denied"
                ? permission.status
                : ("undetermined" as const),
            granted: permission.granted,
          };
    if (!shouldRequestCameraPermission(shaped, promptRequested)) return;
    // oxlint-disable-next-line react/set-state-in-effect -- one-shot per-opening prompt flag; prevents a double system prompt.
    setPromptRequested(true);
    void requestPermission().catch(() => {});
  }, [visible, permission, requestPermission, promptRequested]);

  // Returning from Settings (Open Settings leaves the app) must refresh
  // both the permission and the camera probe. In expo-camera 57
  // `getPermission` re-reads the system state and pushes it into the
  // `useCameraPermissions` hook state, so awaiting it updates the
  // `permission` above; dropping the cached availability runs
  // `isAvailableAsync` again regardless, even if the re-read fails.
  useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (!shouldRefreshCameraOnAppActive(visible, state)) return;
      void getPermission().catch(() => {});
      setCameraAvailable(null);
    });
    return () => subscription.remove();
  }, [visible, getPermission]);

  useEffect(() => {
    if (!visible || permission?.granted !== true || cameraAvailable !== null) return;
    let live = true;
    void CameraView.isAvailableAsync()
      .then((available) => {
        if (live) setCameraAvailable(available);
      })
      .catch(() => {
        if (live) setCameraAvailable(false);
      });
    return () => {
      live = false;
    };
  }, [visible, permission?.granted, cameraAvailable]);

  if (!visible) return null;

  const cancel = () => {
    scanSession.cancel();
    onCancel();
  };
  const deny = (message: string) => {
    scanSession.cancel();
    onDenied(message);
  };

  const scannerState = resolveQrScannerState(
    permission === null
      ? null
      : {
          status:
            permission.status === "granted" || permission.status === "denied"
              ? permission.status
              : "undetermined",
          granted: permission.granted,
        },
    cameraAvailable,
  );
  const denied = scannerState === "denied";
  const noCamera = scannerState === "no-camera";

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={cancel}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {denied ? (
          <DeniedView
            canAskAgain={permission?.canAskAgain === true}
            onAllow={() => void requestPermission().catch(() => {})}
            onSettings={() => void Linking.openSettings()}
            onCancel={() => deny(QR_CAMERA_DENIED_MESSAGE)}
          />
        ) : noCamera ? (
          <UnavailableView onCancel={() => deny(QR_NO_CAMERA_MESSAGE)} />
        ) : scannerState === "preview" ? (
          <View style={{ flex: 1 }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(result) => {
                const resolution = scanSession.offer(result.data ?? "");
                if (resolution?.kind === "code") onScanned(resolution.text);
              }}
            />
            <View
              style={{
                padding: tokens.spacing.xl,
                gap: tokens.spacing.md,
                backgroundColor: theme.colours.background,
              }}
            >
              <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
                Point the camera at the pairing QR code on your computer.
              </Text>
              <AceHost style={{ width: "100%" }}>
                <AceButton label="Cancel" kind="secondary" onPress={cancel} />
              </AceHost>
            </View>
          </View>
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              padding: tokens.spacing.xl,
              backgroundColor: theme.colours.background,
            }}
          >
            <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
              Waiting for camera permission…
            </Text>
            <AceHost style={{ width: "100%" }}>
              <AceButton label="Cancel" kind="secondary" onPress={cancel} />
            </AceHost>
          </View>
        )}
      </View>
    </Modal>
  );
}

function DeniedView({
  canAskAgain,
  onAllow,
  onSettings,
  onCancel,
}: {
  canAskAgain: boolean;
  onAllow(): void;
  onSettings(): void;
  onCancel(): void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        padding: tokens.spacing.xl,
        gap: tokens.spacing.md,
        backgroundColor: theme.colours.background,
      }}
    >
      <Text style={{ ...textStyle("title"), color: theme.colours.foreground }}>Camera is off</Text>
      <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
        {QR_CAMERA_DENIED_MESSAGE}
      </Text>
      {canAskAgain ? (
        <AceHost style={{ width: "100%" }}>
          <AceButton label="Allow camera" onPress={onAllow} />
        </AceHost>
      ) : (
        <AceHost style={{ width: "100%" }}>
          <AceButton label="Open Settings" onPress={onSettings} />
        </AceHost>
      )}
      <AceHost style={{ width: "100%" }}>
        <AceButton label="Cancel" kind="secondary" onPress={onCancel} />
      </AceHost>
    </View>
  );
}

function UnavailableView({ onCancel }: { onCancel(): void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        padding: tokens.spacing.xl,
        gap: tokens.spacing.md,
        backgroundColor: theme.colours.background,
      }}
    >
      <Text style={{ ...textStyle("title"), color: theme.colours.foreground }}>
        No camera available
      </Text>
      <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
        {QR_NO_CAMERA_MESSAGE}
      </Text>
      <AceHost style={{ width: "100%" }}>
        <AceButton label="Back" kind="secondary" onPress={onCancel} />
      </AceHost>
    </View>
  );
}
