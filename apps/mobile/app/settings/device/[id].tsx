import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Alert } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Trash2, Laptop, RefreshCw } from "lucide-react-native";
import { useTheme } from "../../../src/design/ThemeContext";
import { useHostStore } from "../../../src/store/HostStore";
import { connectionManager } from "../../../src/rpc/ConnectionManager";
import { formatErrorMessage } from "../../../src/errors";
import {
  GlassGroup,
  GlassRow,
  LiquidScreen,
  PageHeader,
  RowSeparator,
  SectionLabel,
} from "../../../src/design/LiquidGlass";

export default function DeviceSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useTheme();
  const { hosts, removeHost } = useHostStore();
  const host = hosts.find((h) => h.id === id);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  if (!host) {
    return (
      <LiquidScreen>
        <View style={styles.center}>
          <Text style={{ color: theme.mutedForeground }}>Device not found.</Text>
        </View>
      </LiquidScreen>
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
    <LiquidScreen>
      <Stack.Screen options={{ headerShown: true, title: "", headerBackTitleVisible: false }} />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <PageHeader
            title={host.name}
            subtitle={host.id}
            trailing={<Laptop size={20} color={theme.primary} />}
          />
        </View>

        <View style={styles.section}>
          <SectionLabel>CONNECTION DETAILS</SectionLabel>
          <GlassGroup>
            <GlassRow>
              <View>
                <Text style={[styles.itemLabel, { color: theme.mutedForeground }]}>WS URL</Text>
                <Text style={[styles.itemValue, { color: theme.foreground }]}>{host.wsUrl}</Text>
              </View>
            </GlassRow>
            <RowSeparator inset={16} />
            <GlassRow>
              <View>
                <Text style={[styles.itemLabel, { color: theme.mutedForeground }]}>Session ID</Text>
                <Text style={[styles.itemValue, { color: theme.foreground }]}>
                  {host.clientSessionId}
                </Text>
              </View>
            </GlassRow>
          </GlassGroup>
        </View>

        <View style={styles.section}>
          <GlassGroup>
            <GlassRow onPress={reconnect} disabled={reconnecting} style={styles.actionCard}>
              <RefreshCw size={20} color={theme.primary} />
              <Text style={[styles.actionText, { color: theme.primary }]}>
                {reconnecting ? "Restarting Connection..." : "Restart Connection"}
              </Text>
            </GlassRow>
            <RowSeparator inset={16} />
            <GlassRow onPress={handleDelete} style={styles.actionCard}>
              <Trash2 size={20} color={theme.destructive} />
              <Text style={[styles.actionText, { color: theme.destructive }]}>Remove Device</Text>
            </GlassRow>
          </GlassGroup>
          {reconnectError ? (
            <Text style={[styles.errorText, { color: theme.destructive }]}>{reconnectError}</Text>
          ) : null}
        </View>
      </ScrollView>
    </LiquidScreen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
  },
  section: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  scrollContent: {
    paddingBottom: 44,
  },
  itemLabel: {
    fontSize: 10,
    fontWeight: "700",
    marginBottom: 4,
  },
  itemValue: {
    fontSize: 14,
  },
  actionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  actionText: {
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    marginTop: 8,
    marginLeft: 4,
    fontSize: 12,
    lineHeight: 16,
  },
});
