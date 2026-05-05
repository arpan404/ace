import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View, ScrollView, StyleSheet, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Server, Plus, ChevronRight, RefreshCw, Search, Bell } from "lucide-react-native";
import { useTheme } from "../src/design/ThemeContext";
import { Layout, withAlpha } from "../src/design/system";
import {
  EmptyState,
  IconButton,
  NoticeBanner,
  MetricCard,
  Panel,
  ScreenBackdrop,
  ScreenHeaderV2,
  SectionTitle,
  StatusBadge,
} from "../src/design/primitives";
import { useHostStore } from "../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../src/rpc/ConnectionManager";
import { formatErrorMessage } from "../src/errors";

export default function HostsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { hosts } = useHostStore();
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [reconnectingHostId, setReconnectingHostId] = useState<string | null>(null);
  const [reconnectErrors, setReconnectErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setConnections(connectionManager.getConnections());
    return connectionManager.onStatusChange(setConnections);
  }, []);

  const connectedCount = connections.filter((c) => c.status.kind === "connected").length;

  const reconnectHost = useCallback(
    async (hostId: string) => {
      const host = hosts.find((candidate) => candidate.id === hostId);
      if (!host || reconnectingHostId) {
        return;
      }

      setReconnectingHostId(host.id);
      setReconnectErrors((current) => {
        const { [host.id]: _removed, ...rest } = current;
        return rest;
      });
      try {
        const client = await connectionManager.connect(host, { forceReconnect: true });
        await client.server.getConfig();
      } catch (error) {
        setReconnectErrors((current) => ({
          ...current,
          [host.id]: formatErrorMessage(error),
        }));
      } finally {
        setReconnectingHostId(null);
      }
    },
    [hosts, reconnectingHostId],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 14,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
      >
        <ScreenHeaderV2
          title="Hosts"
          subtitle="Connected machines, provider readiness, and environment health."
          actions={
            <View style={styles.headerActions}>
              <IconButton
                icon={Bell}
                label="Alerts"
                onPress={() => router.push("/notifications")}
              />
              <IconButton
                icon={Plus}
                label="Pair"
                onPress={() => router.push("/pairing")}
                tone="primary"
              />
            </View>
          }
        />

        <View style={styles.metricRow}>
          <MetricCard label="Paired" value={hosts.length} tone="accent" />
          <MetricCard label="Online" value={connectedCount} tone="success" />
          <MetricCard
            label="Offline"
            value={Math.max(0, hosts.length - connectedCount)}
            tone="muted"
          />
        </View>

        {hosts.length === 0 ? (
          <View style={styles.emptyWrap}>
            <EmptyState
              title="No hosts paired"
              body="Scan the pairing code from ace Desktop to connect a machine for mobile agent control."
              action={
                <IconButton
                  icon={Plus}
                  label="Pair Host"
                  onPress={() => router.push("/pairing")}
                  tone="primary"
                />
              }
            />
          </View>
        ) : (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <SectionTitle>Infrastructure</SectionTitle>
              <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
                {hosts.length} hosts
              </Text>
            </View>
            <Panel padded={false} style={styles.hostList}>
              {hosts.map((host, i) => {
                const conn = connections.find((c) => c.host.id === host.id);
                const isConnected = conn?.status.kind === "connected";
                const connectionError =
                  conn?.status.kind === "disconnected" && conn.status.error
                    ? conn.status.error
                    : reconnectErrors[host.id];
                const reconnecting = reconnectingHostId === host.id;
                return (
                  <View key={host.id}>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: "/host/[hostId]",
                          params: { hostId: host.id },
                        })
                      }
                      style={({ pressed }) => [
                        styles.hostRow,
                        {
                          backgroundColor: pressed
                            ? withAlpha(colors.text.primary, 0.03)
                            : "transparent",
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.hostIconWrap,
                          {
                            backgroundColor: isConnected
                              ? withAlpha(colors.status.success, 0.12)
                              : withAlpha(colors.status.muted, 0.12),
                          },
                        ]}
                      >
                        <Server
                          size={18}
                          color={isConnected ? colors.status.success : colors.status.muted}
                          strokeWidth={2.1}
                        />
                      </View>
                      <View style={styles.hostContent}>
                        <View style={styles.hostTitleRow}>
                          <Text
                            style={[styles.hostName, { color: colors.text.primary }]}
                            numberOfLines={1}
                          >
                            {host.name}
                          </Text>
                          <StatusBadge
                            label={isConnected ? "Connected" : "Offline"}
                            tone={isConnected ? "success" : connectionError ? "danger" : "muted"}
                          />
                        </View>
                        <Text
                          style={[styles.hostStatus, { color: colors.text.secondary }]}
                          numberOfLines={2}
                        >
                          {connectionError ? connectionError : host.wsUrl}
                        </Text>
                      </View>
                      <View style={styles.hostActions}>
                        {!isConnected ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Reconnect ${host.name}`}
                            disabled={reconnectingHostId !== null}
                            onPress={() => void reconnectHost(host.id)}
                            style={({ pressed }) => [
                              styles.reconnectButton,
                              {
                                backgroundColor: colors.surfaces.muted,
                                borderColor: colors.border.soft,
                              },
                              pressed && { opacity: 0.7 },
                              reconnectingHostId !== null && styles.disabled,
                            ]}
                          >
                            {reconnecting ? (
                              <ActivityIndicator color={colors.accent.primary} />
                            ) : (
                              <RefreshCw
                                size={16}
                                color={colors.accent.primary}
                                strokeWidth={2.2}
                              />
                            )}
                          </Pressable>
                        ) : null}
                        <ChevronRight size={16} color={colors.text.tertiary} strokeWidth={2.1} />
                      </View>
                    </Pressable>
                    {i < hosts.length - 1 && (
                      <View style={[styles.separator, { backgroundColor: colors.border.soft }]} />
                    )}
                  </View>
                );
              })}

              <Pressable
                onPress={() => router.push("/pairing")}
                style={({ pressed }) => [
                  styles.addRow,
                  {
                    backgroundColor: pressed ? withAlpha(colors.text.primary, 0.03) : "transparent",
                  },
                ]}
              >
                <Plus size={18} color={colors.accent.primary} strokeWidth={2} />
                <Text style={[styles.addRowText, { color: colors.accent.primary }]}>
                  Pair new host
                </Text>
              </Pressable>
            </Panel>
          </View>
        )}
        {Object.keys(reconnectErrors).length > 0 ? (
          <NoticeBanner
            tone="danger"
            title="Some hosts failed to reconnect"
            body="Open the host details to inspect errors and retry."
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  metricRow: {
    marginTop: 2,
    flexDirection: "row",
    gap: 10,
  },
  emptyWrap: {
    marginTop: 24,
  },
  section: {
    marginTop: 28,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  sectionMeta: {
    fontSize: 11,
  },
  hostList: {
    overflow: "hidden",
  },
  hostRow: {
    minHeight: 78,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  hostIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  hostContent: {
    flex: 1,
  },
  hostTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  hostName: {
    fontSize: 15,
    fontWeight: "600",
    flex: 1,
  },
  hostStatus: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  hostActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  reconnectButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  addRow: {
    minHeight: 58,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  addRowText: {
    fontSize: 14,
    fontWeight: "600",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 68,
  },
  disabled: {
    opacity: 0.55,
  },
});
