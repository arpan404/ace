import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View, ScrollView, StyleSheet, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Server, Plus, ChevronRight, RefreshCw, Search } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import {
  EmptyState,
  IconButton,
  MetricCard,
  Panel,
  ScreenBackdrop,
  ScreenHeader,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { formatErrorMessage } from "../../src/errors";

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
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
      >
        <ScreenHeader
          eyebrow="ace"
          title="Hosts"
          subtitle="Pair, inspect, and reconnect desktop agents across every reachable machine."
          action={
            <View style={styles.headerActions}>
              <IconButton icon={Search} label="Find" onPress={() => router.push("/search")} />
              <IconButton icon={Plus} label="Pair" onPress={() => router.push("/pairing")} />
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
                <IconButton icon={Plus} label="Pair Host" onPress={() => router.push("/pairing")} />
              }
            />
          </View>
        ) : (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <SectionTitle>Paired Hosts</SectionTitle>
              <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
                {hosts.length} total
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
                            ? withAlpha(colors.foreground, 0.04)
                            : "transparent",
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.hostIconWrap,
                          {
                            backgroundColor: isConnected
                              ? withAlpha(colors.green, 0.14)
                              : withAlpha(colors.muted, 0.14),
                          },
                        ]}
                      >
                        <Server
                          size={18}
                          color={isConnected ? colors.green : colors.muted}
                          strokeWidth={2.2}
                        />
                      </View>
                      <View style={styles.hostContent}>
                        <View style={styles.hostTitleRow}>
                          <Text
                            style={[styles.hostName, { color: colors.foreground }]}
                            numberOfLines={1}
                          >
                            {host.name}
                          </Text>
                          <StatusBadge
                            label={isConnected ? "online" : "offline"}
                            tone={isConnected ? "success" : connectionError ? "danger" : "muted"}
                          />
                        </View>
                        <Text
                          style={[styles.hostStatus, { color: colors.secondaryLabel }]}
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
                                backgroundColor: withAlpha(colors.primary, 0.12),
                                borderColor: withAlpha(colors.primary, 0.22),
                              },
                              pressed && { opacity: 0.7 },
                              reconnectingHostId !== null && styles.disabled,
                            ]}
                          >
                            {reconnecting ? (
                              <ActivityIndicator color={colors.primary} />
                            ) : (
                              <RefreshCw size={17} color={colors.primary} strokeWidth={2.3} />
                            )}
                          </Pressable>
                        ) : null}
                        <ChevronRight size={16} color={colors.muted} strokeWidth={2.2} />
                      </View>
                    </Pressable>
                    {i < hosts.length - 1 && (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    )}
                  </View>
                );
              })}

              <Pressable
                onPress={() => router.push("/pairing")}
                style={({ pressed }) => [
                  styles.addRow,
                  {
                    backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
                  },
                ]}
              >
                <Plus size={18} color={colors.primary} strokeWidth={2} />
                <Text style={[styles.addRowText, { color: colors.primary }]}>Pair New Host</Text>
              </Pressable>
            </Panel>
          </View>
        )}
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
    marginTop: 22,
    flexDirection: "row",
    gap: 10,
  },
  emptyWrap: {
    marginTop: 24,
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionMeta: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  hostList: { overflow: "hidden" },
  hostRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: 88,
    gap: 13,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 71,
    right: 18,
    height: StyleSheet.hairlineWidth,
  },
  hostIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  hostContent: { flex: 1, minWidth: 0 },
  hostTitleRow: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  hostName: {
    flex: 1,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: "800",
    letterSpacing: -0.25,
  },
  hostStatus: {
    marginTop: 7,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  hostActions: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  reconnectButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  disabled: { opacity: 0.45 },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 58,
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 12,
  },
  addRowText: { fontSize: 15, lineHeight: 19, fontWeight: "800" },
});
