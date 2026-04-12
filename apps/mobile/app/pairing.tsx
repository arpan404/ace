import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View, Text, StyleSheet, Pressable } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { X } from "lucide-react-native";
import { useTheme } from "../src/design/ThemeContext";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import {
  createHostInstance,
  parseHostConnectionQrPayload,
  requestRelayConnection,
} from "../src/hostInstances";
import { useHostStore } from "../src/store/HostStore";
import { formatErrorMessage } from "../src/errors";

export default function PairingScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const addHost = useHostStore((s) => s.addHost);
  const [scanPaused, setScanPaused] = useState(false);
  const scanLockedRef = useRef(false);

  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(1);

  useEffect(() => {
    pulseScale.value = withRepeat(
      withSequence(withTiming(1.04, { duration: 1200 }), withTiming(1, { duration: 1200 })),
      -1,
      true,
    );
    pulseOpacity.value = withRepeat(
      withSequence(withTiming(0.6, { duration: 1200 }), withTiming(1, { duration: 1200 })),
      -1,
      true,
    );
  }, [pulseScale, pulseOpacity]);

  const animatedFinderStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  const requestCameraPermission = async () => {
    try {
      await requestPermission();
    } catch (error) {
      Alert.alert("Permission failed", formatErrorMessage(error));
    }
  };

  const resumeScanning = useCallback(() => {
    scanLockedRef.current = false;
    setScanPaused(false);
  }, []);

  const pauseWithAlert = useCallback(
    (title: string, message: string) => {
      setScanPaused(true);
      Alert.alert(title, message, [{ text: "Scan again", onPress: resumeScanning }], {
        cancelable: true,
        onDismiss: resumeScanning,
      });
    },
    [resumeScanning],
  );

  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (scanLockedRef.current) {
        return;
      }
      scanLockedRef.current = true;
      setScanPaused(true);

      try {
        const parsed = parseHostConnectionQrPayload(data);
        if (!parsed) {
          pauseWithAlert(
            "Invalid QR Code",
            "The scanned code is not a valid ace host pairing code.",
          );
          return;
        }

        if (parsed.kind === "direct") {
          const host = createHostInstance(parsed.draft);
          addHost(host);
          router.back();
          return;
        }

        if (parsed.kind === "relay") {
          const resolvedHost = await requestRelayConnection(parsed.relay, {
            requesterName: "ace mobile",
          });
          const host = createHostInstance({
            wsUrl: resolvedHost.wsUrl,
            ...(resolvedHost.authToken !== undefined ? { authToken: resolvedHost.authToken } : {}),
            ...(resolvedHost.name ? { name: resolvedHost.name } : {}),
          });
          addHost(host);
          router.back();
          return;
        }

        pauseWithAlert(
          "Unsupported QR Code",
          "This pairing format is no longer supported. Generate a relay connection string from host settings.",
        );
      } catch (error) {
        pauseWithAlert("Pairing failed", formatErrorMessage(error));
      }
    },
    [addHost, pauseWithAlert, router],
  );

  if (!permission) {
    return <View />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.foreground, textAlign: "center", marginBottom: 20 }}>
          We need your permission to show the camera
        </Text>
        <Pressable
          onPress={requestCameraPermission}
          style={[styles.button, { backgroundColor: theme.primary }]}
        >
          <Text style={{ color: theme.primaryForeground, fontWeight: "600" }}>
            Grant Permission
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        onBarcodeScanned={scanPaused ? undefined : (event) => void handleBarCodeScanned(event)}
        barcodeScannerSettings={{
          barcodeTypes: ["qr"],
        }}
      />
      <View style={styles.overlay}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.closeButton}>
            <X color="#fff" size={24} />
          </Pressable>
        </View>

        <Animated.View style={[styles.finder, animatedFinderStyle]}>
          <View style={[styles.corner, styles.topLeft, { borderColor: theme.primary }]} />
          <View style={[styles.corner, styles.topRight, { borderColor: theme.primary }]} />
          <View style={[styles.corner, styles.bottomLeft, { borderColor: theme.primary }]} />
          <View style={[styles.corner, styles.bottomRight, { borderColor: theme.primary }]} />
        </Animated.View>

        <Text style={styles.hint}>Scan the QR code on your ace Desktop</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
  },
  button: {
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginHorizontal: 40,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  header: {
    position: "absolute",
    top: 50,
    right: 20,
  },
  closeButton: {
    padding: 10,
    borderRadius: 30,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  finder: {
    width: 260,
    height: 260,
    borderWidth: 0,
    backgroundColor: "transparent",
  },
  hint: {
    color: "rgba(255,255,255,0.8)",
    marginTop: 50,
    fontSize: 16,
    fontWeight: "500",
    letterSpacing: 0.3,
  },
  corner: {
    position: "absolute",
    width: 50,
    height: 50,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 5,
    borderLeftWidth: 5,
    borderTopLeftRadius: 24,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 5,
    borderRightWidth: 5,
    borderTopRightRadius: 24,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 5,
    borderLeftWidth: 5,
    borderBottomLeftRadius: 24,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 5,
    borderRightWidth: 5,
    borderBottomRightRadius: 24,
  },
});
