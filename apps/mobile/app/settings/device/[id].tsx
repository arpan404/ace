import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Alert, Pressable, TextInput } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, RefreshCw, Star, Trash2 } from "lucide-react-native";
import { useTheme } from "../../../src/design/ThemeContext";
import { useHostStore } from "../../../src/store/HostStore";
import { connectionManager } from "../../../src/rpc/ConnectionManager";
import { formatErrorMessage } from "../../../src/errors";
import { createHostInstance } from "../../../src/hostInstances";

export default function DeviceSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { hosts, activeHostId, removeHost, setActiveHost, updateHost } = useHostStore();
  const host = hosts.find((h) => h.id === id);
  const [nameDraft, setNameDraft] = useState("");
  const [wsUrlDraft, setWsUrlDraft] = useState("");
  const [authTokenDraft, setAuthTokenDraft] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<{
    kind: "connected" | "disconnected";
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!host) return;
    setNameDraft(host.name);
    setWsUrlDraft(host.wsUrl);
    setAuthTokenDraft(host.authToken);
  }, [host]);

  const hasDraftChanges = useMemo(() => {
    if (!host) return false;
    return (
      nameDraft.trim() !== host.name ||
      wsUrlDraft.trim() !== host.wsUrl ||
      authTokenDraft.trim() !== host.authToken
    );
  }, [authTokenDraft, host, nameDraft, wsUrlDraft]);

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

  const saveChanges = () => {
    if (!host || !hasDraftChanges) return;
    setSaveError(null);
    try {
      const nextHost = createHostInstance(
        {
          name: nameDraft.trim(),
          wsUrl: wsUrlDraft.trim(),
          authToken: authTokenDraft.trim(),
        },
        host,
      );
      updateHost(nextHost);
      Alert.alert("Host updated", `${nextHost.name} was saved and reconnected.`);
    } catch (error) {
      const message = formatErrorMessage(error);
      setSaveError(message);
      Alert.alert("Could not save host", message);
    }
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

        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 32 }]}>
          HOST CONFIGURATION
        </Text>
        <View style={styles.formGroup}>
          <Text style={[styles.inputLabel, { color: colors.muted }]}>Display name</Text>
          <TextInput
            value={nameDraft}
            onChangeText={setNameDraft}
            placeholder="Host name"
            placeholderTextColor={colors.muted}
            autoCapitalize="words"
            autoCorrect={false}
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.secondaryGroupedBackground,
                borderColor: colors.separator,
              },
            ]}
          />
          <Text style={[styles.inputLabel, { color: colors.muted }]}>WebSocket URL</Text>
          <TextInput
            value={wsUrlDraft}
            onChangeText={setWsUrlDraft}
            placeholder="ws://host:3773/ws"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.secondaryGroupedBackground,
                borderColor: colors.separator,
              },
            ]}
          />
          <Text style={[styles.inputLabel, { color: colors.muted }]}>Auth token</Text>
          <TextInput
            value={authTokenDraft}
            onChangeText={setAuthTokenDraft}
            placeholder="Optional token"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.secondaryGroupedBackground,
                borderColor: colors.separator,
              },
            ]}
          />
          <Pressable
            onPress={saveChanges}
            disabled={!hasDraftChanges}
            style={[
              styles.primaryAction,
              {
                backgroundColor: hasDraftChanges
                  ? colors.primary
                  : colors.secondaryGroupedBackground,
                borderColor: hasDraftChanges ? colors.primary : colors.separator,
              },
              !hasDraftChanges && styles.disabled,
            ]}
          >
            <Check
              size={17}
              color={hasDraftChanges ? colors.primaryForeground : colors.muted}
              strokeWidth={2.3}
            />
            <Text
              style={[
                styles.primaryActionText,
                { color: hasDraftChanges ? colors.primaryForeground : colors.muted },
              ]}
            >
              Save and Reconnect
            </Text>
          </Pressable>
          {saveError ? (
            <Text style={[styles.errorText, { color: colors.red }]}>{saveError}</Text>
          ) : null}
        </View>

        {/* Actions */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 32 }]}>ACTIONS</Text>
        <Pressable
          onPress={() => setActiveHost(host.id)}
          disabled={activeHostId === host.id}
          style={({ pressed }) => [
            styles.actionRow,
            pressed && { opacity: 0.6 },
            activeHostId === host.id && styles.disabled,
          ]}
        >
          <Star size={18} color={colors.primary} strokeWidth={2} />
          <Text style={[styles.actionText, { color: colors.primary }]}>
            {activeHostId === host.id ? "Default Host" : "Make Default Host"}
          </Text>
        </Pressable>
        <View style={[styles.actionSeparator, { backgroundColor: colors.separator }]} />
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
  formGroup: {
    paddingHorizontal: 20,
    gap: 10,
  },
  inputLabel: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.35,
  },
  input: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
  },
  primaryAction: {
    minHeight: 46,
    marginTop: 4,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryActionText: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.58,
  },
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
