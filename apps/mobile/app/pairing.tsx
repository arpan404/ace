import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowRight, ClipboardPaste, Keyboard, ScanLine, X } from "lucide-react-native";
import { useTheme } from "../src/design/ThemeContext";
import {
  createHostInstance,
  parseHostConnectionQrPayload,
  requestPairingClaim,
  waitForPairingApproval,
} from "../src/hostInstances";
import { useHostStore } from "../src/store/HostStore";
import { formatErrorMessage } from "../src/errors";

type ConnectionTab = "scan" | "paste" | "manual";

const SCAN_AREA_SIZE = 260;
const SCAN_LINE_PERIOD = 2400;
const PAIRING_REQUEST_TIMEOUT_MS = 10_000;

const TAB_META: { key: ConnectionTab; label: string; Icon: React.ElementType }[] = [
  { key: "scan", label: "Scan", Icon: ScanLine },
  { key: "paste", label: "Paste", Icon: ClipboardPaste },
  { key: "manual", label: "Manual", Icon: Keyboard },
];

export default function PairingScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const addHost = useHostStore((s) => s.addHost);

  const [activeTab, setActiveTab] = useState<ConnectionTab>("scan");
  const [scanPaused, setScanPaused] = useState(false);
  const scanLockedRef = useRef(false);

  const [pasteValue, setPasteValue] = useState("");
  const [manualValue, setManualValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [statusText, setStatusText] = useState("");

  // Scan line animation
  const scanLineY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineY, {
          toValue: SCAN_AREA_SIZE - 2,
          duration: SCAN_LINE_PERIOD,
          useNativeDriver: true,
        }),
        Animated.timing(scanLineY, {
          toValue: 0,
          duration: SCAN_LINE_PERIOD,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [scanLineY]);

  const clearError = useCallback(() => setError(null), []);

  const handleConnect = useCallback(
    async (data: string) => {
      setError(null);
      const parsed = parseHostConnectionQrPayload(data);
      if (!parsed) {
        setError("Not a valid ace pairing link or host URL.");
        return;
      }

      try {
        setConnecting(true);

        if (parsed.kind === "direct") {
          setStatusText("Connecting…");
          const host = createHostInstance(parsed.draft);
          addHost(host);
          router.back();
          return;
        }

        if (parsed.kind === "pairing") {
          setStatusText("Connecting…");
          const receipt = await requestPairingClaim(parsed.pairing, {
            requesterName: "ace mobile",
            requestTimeoutMs: PAIRING_REQUEST_TIMEOUT_MS,
          });
          setStatusText("Waiting for approval…");
          const resolvedHost = await waitForPairingApproval(receipt, {
            timeoutMs: 90_000,
            pollIntervalMs: 1_200,
            requestTimeoutMs: PAIRING_REQUEST_TIMEOUT_MS,
          });
          const host = createHostInstance(resolvedHost);
          addHost(host);
          router.back();
          return;
        }
      } catch (err) {
        setError(formatErrorMessage(err));
      } finally {
        setConnecting(false);
        setStatusText("");
      }
    },
    [addHost, router],
  );

  // QR scan handler
  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (scanLockedRef.current) return;
      scanLockedRef.current = true;
      setScanPaused(true);
      setStatusText("Scanning…");

      await handleConnect(data);

      // Allow re-scanning on error
      scanLockedRef.current = false;
      setScanPaused(false);
    },
    [handleConnect],
  );

  const handlePasteSubmit = useCallback(() => {
    const trimmed = pasteValue.trim();
    if (!trimmed) return;
    void handleConnect(trimmed);
  }, [handleConnect, pasteValue]);

  const handleManualSubmit = useCallback(() => {
    const trimmed = manualValue.trim();
    if (!trimmed) return;
    void handleConnect(trimmed);
  }, [handleConnect, manualValue]);

  // Camera permission states
  if (!permission) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  if (!permission.granted && activeTab === "scan") {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Pressable
          onPress={() => router.back()}
          style={[styles.closeBtn, { top: insets.top + 10 }]}
        >
          <X size={20} color="#fff" />
        </Pressable>
        <Text style={[styles.permissionText, { color: colors.foreground }]}>
          Camera access is needed to scan QR codes
        </Text>
        <Pressable
          onPress={() => void requestPermission()}
          style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.primaryBtnText}>Grant Permission</Text>
        </Pressable>
        <TabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          colors={colors}
          bottomInset={insets.bottom}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Camera always mounted behind so switching tabs is instant */}
      {permission.granted && (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          onBarcodeScanned={
            scanPaused || activeTab !== "scan"
              ? undefined
              : (event) => void handleBarCodeScanned(event)
          }
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        />
      )}

      {/* Dark overlay with cutout for scan mode */}
      {activeTab === "scan" && <ScanOverlay scanLineY={scanLineY} primaryColor={colors.primary} />}

      {/* Close button */}
      <Pressable onPress={() => router.back()} style={[styles.closeBtn, { top: insets.top + 10 }]}>
        <X size={20} color="#fff" />
      </Pressable>

      {/* Scan hint */}
      {activeTab === "scan" && !connecting && (
        <View style={styles.scanHintContainer}>
          <Text style={styles.scanHint}>{error ?? "Point at a QR code on your ace desktop"}</Text>
        </View>
      )}

      {/* Paste / Manual input card */}
      {activeTab !== "scan" && (
        <View
          style={[
            styles.inputCard,
            { backgroundColor: colors.secondaryGroupedBackground, borderColor: colors.separator },
          ]}
        >
          {activeTab === "paste" && (
            <>
              <Text style={[styles.inputLabel, { color: colors.secondaryLabel }]}>
                Paste an ace:// pairing link or host URL
              </Text>
              <TextInput
                style={[
                  styles.textInput,
                  {
                    backgroundColor: colors.background,
                    color: colors.foreground,
                    borderColor: error ? colors.red : colors.separator,
                  },
                ]}
                placeholder="ace://pair?p=… or ws://host:port"
                placeholderTextColor={colors.muted}
                value={pasteValue}
                onChangeText={(t) => {
                  setPasteValue(t);
                  clearError();
                }}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={handlePasteSubmit}
              />
            </>
          )}
          {activeTab === "manual" && (
            <>
              <Text style={[styles.inputLabel, { color: colors.secondaryLabel }]}>
                Enter a host WebSocket URL
              </Text>
              <TextInput
                style={[
                  styles.textInput,
                  {
                    backgroundColor: colors.background,
                    color: colors.foreground,
                    borderColor: error ? colors.red : colors.separator,
                  },
                ]}
                placeholder="ws://192.168.1.100:3773"
                placeholderTextColor={colors.muted}
                value={manualValue}
                onChangeText={(t) => {
                  setManualValue(t);
                  clearError();
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={handleManualSubmit}
              />
            </>
          )}

          {error && <Text style={[styles.errorText, { color: colors.red }]}>{error}</Text>}

          <Pressable
            onPress={activeTab === "paste" ? handlePasteSubmit : handleManualSubmit}
            disabled={connecting}
            style={[styles.connectBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={styles.connectBtnText}>Connect</Text>
            <ArrowRight size={16} color={colors.primaryForeground} />
          </Pressable>
        </View>
      )}

      {/* Loading overlay */}
      {connecting && (
        <View style={styles.loadingOverlay}>
          <View style={styles.loadingCard}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.foreground }]}>{statusText}</Text>
          </View>
        </View>
      )}

      {/* Tab bar */}
      <TabBar
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          setError(null);
        }}
        colors={colors}
        bottomInset={insets.bottom}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// ScanOverlay — dark mask with transparent cutout + animated scan line
// ---------------------------------------------------------------------------

function ScanOverlay({
  scanLineY,
  primaryColor,
}: {
  scanLineY: Animated.Value;
  primaryColor: string;
}) {
  const { width, height } = Dimensions.get("window");
  const cx = width / 2;
  const cy = height / 2 - 40; // offset upward slightly
  const half = SCAN_AREA_SIZE / 2;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Top */}
      <View style={[styles.maskRegion, { top: 0, left: 0, right: 0, height: cy - half }]} />
      {/* Bottom */}
      <View style={[styles.maskRegion, { top: cy + half, left: 0, right: 0, bottom: 0 }]} />
      {/* Left */}
      <View
        style={[
          styles.maskRegion,
          { top: cy - half, left: 0, width: cx - half, height: SCAN_AREA_SIZE },
        ]}
      />
      {/* Right */}
      <View
        style={[
          styles.maskRegion,
          { top: cy - half, right: 0, width: cx - half, height: SCAN_AREA_SIZE },
        ]}
      />

      {/* Corner accents */}
      <View style={{ position: "absolute", top: cy - half, left: cx - half }}>
        <View style={[styles.corner, styles.topLeft, { borderColor: primaryColor }]} />
        <View style={[styles.corner, styles.topRight, { borderColor: primaryColor }]} />
        <View style={[styles.corner, styles.bottomLeft, { borderColor: primaryColor }]} />
        <View style={[styles.corner, styles.bottomRight, { borderColor: primaryColor }]} />

        {/* Animated scan line */}
        <Animated.View
          style={[
            styles.scanLine,
            { backgroundColor: primaryColor, transform: [{ translateY: scanLineY }] },
          ]}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// TabBar — segmented pill tabs
// ---------------------------------------------------------------------------

function TabBar({
  activeTab,
  onTabChange,
  colors,
  bottomInset,
}: {
  activeTab: ConnectionTab;
  onTabChange: (tab: ConnectionTab) => void;
  colors: ReturnType<typeof useTheme>["colors"];
  bottomInset: number;
}) {
  return (
    <View style={[styles.tabBarOuter, { paddingBottom: Math.max(bottomInset, 16) }]}>
      <View style={[styles.tabBarInner, { backgroundColor: "rgba(0,0,0,0.55)" }]}>
        {TAB_META.map(({ key, label, Icon }) => {
          const active = key === activeTab;
          return (
            <Pressable
              key={key}
              onPress={() => onTabChange(key)}
              style={[
                styles.tabItem,
                active && { backgroundColor: colors.primary, borderRadius: 20 },
              ]}
            >
              <Icon size={16} color={active ? colors.primaryForeground : "rgba(255,255,255,0.7)"} />
              <Text
                style={[
                  styles.tabLabel,
                  { color: active ? colors.primaryForeground : "rgba(255,255,255,0.7)" },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
  },

  // Close button
  closeBtn: {
    position: "absolute",
    right: 16,
    zIndex: 10,
    padding: 10,
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.4)",
  },

  // Permission screen
  permissionText: {
    textAlign: "center",
    fontSize: 16,
    marginBottom: 20,
    marginHorizontal: 40,
  },
  primaryBtn: {
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginHorizontal: 40,
  },
  primaryBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },

  // Scan overlay regions
  maskRegion: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.6)",
  },

  // Corner accents inside the cutout
  corner: {
    position: "absolute",
    width: 36,
    height: 36,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 16,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 16,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 16,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 16,
  },

  // Animated scan line
  scanLine: {
    position: "absolute",
    left: 8,
    right: 8,
    height: 2,
    borderRadius: 1,
    opacity: 0.8,
  },

  // Scan hint
  scanHintContainer: {
    position: "absolute",
    bottom: 140,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scanHint: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 15,
    fontWeight: "500",
    textAlign: "center",
    marginHorizontal: 40,
  },

  // Input card
  inputCard: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 120,
    borderRadius: 20,
    padding: 20,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: "500",
    marginBottom: 10,
  },
  textInput: {
    fontSize: 15,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorText: {
    fontSize: 13,
    marginTop: 8,
  },
  connectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 14,
    paddingVertical: 13,
    borderRadius: 12,
  },
  connectBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },

  // Loading overlay
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 20,
  },
  loadingCard: {
    alignItems: "center",
    gap: 14,
  },
  loadingText: {
    fontSize: 16,
    fontWeight: "500",
  },

  // Tab bar
  tabBarOuter: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingTop: 8,
  },
  tabBarInner: {
    flexDirection: "row",
    borderRadius: 24,
    padding: 4,
    gap: 2,
  },
  tabItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
});
