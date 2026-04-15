import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Alert, Pressable } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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

  if (!host) {
    return (
      <View style={[styles.root, { backgroundColor: colors.groupedBackground }]}>
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
    <View style={[styles.root, { backgroundColor: colors.groupedBackground }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: host.name,
          headerBackTitleVisible: false,
          headerStyle: { backgroundColor: colors.groupedBackground },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.foreground },
        }}
      />

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {/* Connection Details */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>CONNECTION DETAILS</Text>
        </View>
        <View
          style={[styles.groupContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
        >
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>WS URL</Text>
            <Text style={[styles.detailValue, { color: colors.foreground }]} numberOfLines={2}>
              {host.wsUrl}
            </Text>
          </View>
          <View style={[styles.separator, { backgroundColor: colors.separator }]} />
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.muted }]}>Session ID</Text>
            <Text style={[styles.detailValue, { color: colors.foreground }]} numberOfLines={1}>
              {host.clientSessionId}
            </Text>
          </View>
        </View>

        {/* Actions */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>ACTIONS</Text>
        </View>
        <View
          style={[styles.groupContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
        >
          <Pressable
            onPress={() => void reconnect()}
            disabled={reconnecting}
            style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: colors.fill }]}
          >
            <Text style={[styles.actionText, { color: colors.primary }]}>
              {reconnecting ? "Restarting Connection…" : "🔄 Restart Connection"}
            </Text>
          </Pressable>
          <View style={[styles.separator, { backgroundColor: colors.separator }]} />
          <Pressable
            onPress={handleDelete}
            style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: colors.fill }]}
          >
            <Text style={[styles.actionText, { color: colors.red }]}>🗑️ Remove Device</Text>
          </Pressable>
        </View>

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
  sectionHeader: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  groupContainer: {
    marginHorizontal: 20,
    borderRadius: 12,
    overflow: "hidden",
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  detailRow: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailValue: { fontSize: 15 },
  actionRow: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 44,
    justifyContent: "center",
  },
  actionText: { fontSize: 17, fontWeight: "500" },
  errorText: {
    marginTop: 12,
    marginHorizontal: 24,
    fontSize: 14,
    lineHeight: 20,
  },
});
