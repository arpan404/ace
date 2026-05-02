import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Alert, Pressable } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RefreshCw, Trash2 } from "lucide-react-native";
import { useTheme } from "../../../src/design/ThemeContext";
import { useHostStore } from "../../../src/store/HostStore";
import { connectionManager } from "../../../src/rpc/ConnectionManager";
import { formatErrorMessage } from "../../../src/errors";

export default function DeviceSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { hosts, removeHost } = useHostStore();
  const host = hosts.find((h) => h.id === id);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<{
    kind: "connected" | "disconnected";
    error?: string;
  } | null>(null);

  useEffect(() => {
    const updateStatus = () => {
      const connection = connectionManager
        .getConnections()
        .find((candidate) => candidate.host.id === id);
      setConnectionStatus(connection?.status ?? null);
    };

    updateStatus();
    return connectionManager.onStatusChange(() => {
      updateStatus();
    });
  }, [id]);

  if (!host) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: "" }} />
        <View style={styles.center}>
          <Text style={{ color: colors.muted }}>Device not found.</Text>
        </View>
      </View>
    );
  }

  const handleDelete = () => {
    Alert.alert("Remove Device", `Are you sure you want to remove ${host.name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          removeHost(host.id);
          router.back();
        },
      },
    ]);
  };

  const reconnect = async () => {
    setReconnectError(null);
    setReconnecting(true);
    try {
      await connectionManager.disconnect(host.id);
      await connectionManager.connect(host);
    } catch (error) {
      const message = formatErrorMessage(error);
      setReconnectError(message);
      Alert.alert("Reconnect failed", message);
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: host.name,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.foreground },
        }}
      />

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {/* Connection Details */}
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>CONNECTION DETAILS</Text>
        <View style={styles.detailGroup}>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>Status</Text>
            <Text
              style={[
                styles.detailValue,
                {
                  color:
                    connectionStatus?.kind === "connected"
                      ? colors.green
                      : connectionStatus?.error
                        ? colors.red
                        : colors.foreground,
                },
              ]}
            >
              {connectionStatus?.kind === "connected"
                ? "Connected"
                : connectionStatus?.error
                  ? `Disconnected: ${connectionStatus.error}`
                  : "Disconnected"}
            </Text>
          </View>
          <View style={[styles.detailSeparator, { backgroundColor: colors.separator }]} />
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>WebSocket URL</Text>
            <Text style={[styles.detailValue, { color: colors.foreground }]} numberOfLines={2}>
              {host.wsUrl}
            </Text>
          </View>
          <View style={[styles.detailSeparator, { backgroundColor: colors.separator }]} />
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>Session ID</Text>
            <Text
              style={[styles.detailValue, { color: colors.foreground, fontFamily: "Menlo" }]}
              numberOfLines={1}
            >
              {host.clientSessionId}
            </Text>
          </View>
        </View>

        {/* Actions */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 32 }]}>ACTIONS</Text>
        <Pressable
          onPress={() => void reconnect()}
          disabled={reconnecting}
          style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.6 }]}
        >
          <RefreshCw
            size={18}
            color={colors.primary}
            strokeWidth={2}
            style={reconnecting ? { opacity: 0.5 } : undefined}
          />
          <Text style={[styles.actionText, { color: colors.primary }]}>
            {reconnecting ? "Restarting…" : "Restart Connection"}
          </Text>
        </Pressable>
        <View style={[styles.actionSeparator, { backgroundColor: colors.separator }]} />
        <Pressable
          onPress={handleDelete}
          style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.6 }]}
        >
          <Trash2 size={18} color={colors.red} strokeWidth={2} />
          <Text style={[styles.actionText, { color: colors.red }]}>Remove Device</Text>
        </Pressable>

        {reconnectError ? (
          <Text style={[styles.errorText, { color: colors.red }]}>{reconnectError}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    marginTop: 28,
    marginBottom: 8,
  },
  detailGroup: { paddingHorizontal: 20 },
  detailRow: { paddingVertical: 12 },
  detailLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailValue: { fontSize: 15, lineHeight: 20 },
  detailSeparator: { height: StyleSheet.hairlineWidth },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 12,
    minHeight: 44,
  },
  actionSeparator: { height: StyleSheet.hairlineWidth, marginLeft: 50 },
  actionText: { fontSize: 17, fontWeight: "500" },
  errorText: {
    marginTop: 12,
    marginHorizontal: 24,
    fontSize: 14,
    lineHeight: 20,
  },
});
