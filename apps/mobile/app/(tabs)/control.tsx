import React, { useEffect, useState, useCallback } from "react";
import { View, ScrollView, StyleSheet, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { useUIStateStore } from "../../src/store/UIStateStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import type { OrchestrationSnapshot } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";
import {
  SafeScreen,
  ScreenHeader,
  SectionHeader,
  List,
  ListItem,
  Card,
  StatusBadge,
  ErrorBox,
} from "../../src/design/Components";

export default function ControlScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const activeHostId = useUIStateStore((s) => s.activeHostId);
  const terminalOutput = useUIStateStore((s) => s.terminalOutput);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OrchestrationSnapshot | null>(null);

  const activeConnection = connections.find((c) => c.host.id === activeHostId);
  const activeHost = hosts.find((h) => h.id === activeHostId);

  useEffect(() => {
    return connectionManager.onStatusChange(setConnections);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    if (!activeConnection || activeConnection.status.kind !== "connected") {
      setError("No active connection");
      return;
    }

    setRefreshing(true);
    setError(null);

    try {
      const snap = await activeConnection.client.orchestration.getSnapshot();
      setSnapshot(snap);
    } catch (err) {
      const msg = formatErrorMessage(err);
      setError(msg);
      console.error("Failed to load snapshot:", msg);
    } finally {
      setRefreshing(false);
    }
  }, [activeConnection]);

  useEffect(() => {
    if (activeConnection?.status.kind === "connected") {
      void refreshSnapshot();
    }
  }, [activeConnection?.host.id, activeConnection?.status.kind, refreshSnapshot]);

  const connectionStatus =
    activeConnection?.status.kind === "connected"
      ? "connected"
      : activeConnection?.status.kind === "connecting"
        ? "connecting"
        : "disconnected";

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 12, paddingBottom: 140 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshSnapshot}
            tintColor={theme.primary}
          />
        }
      >
        <ScreenHeader title="Control Panel" subtitle={activeHost?.name || "No host selected"} />

        {error ? <ErrorBox message={error} onDismiss={() => setError(null)} /> : null}

        {/* Connection Status */}
        <SectionHeader title="Connection Status" />
        <Card>
          <View style={styles.statusRow}>
            <View>
              <StatusBadge status={connectionStatus} label={activeHost?.name || "Disconnected"} />
            </View>
            {activeConnection && (
              <View style={styles.statusInfo}>
                <View style={styles.statusDetail}>
                  <View
                    style={[
                      styles.statusIndicator,
                      {
                        backgroundColor:
                          connectionStatus === "connected" ? "#10b981" : theme.mutedForeground,
                      },
                    ]}
                  />
                </View>
              </View>
            )}
          </View>
        </Card>

        {/* Provider Status */}
        {snapshot && snapshot.providers.length > 0 && (
          <>
            <SectionHeader title={`Providers (${snapshot.providers.length})`} />
            <List>
              {snapshot.providers.map((provider) => (
                <ListItem
                  key={provider.key}
                  title={provider.name || provider.key}
                  subtitle={`${provider.models.length} models • ${provider.connectionStatus}`}
                  highlighted={false}
                />
              ))}
            </List>
          </>
        )}

        {/* Session Counts */}
        {snapshot && (
          <>
            <SectionHeader title="Activity" />
            <View style={styles.statsGrid}>
              <Card style={styles.statCard}>
                <View style={styles.stat}>
                  <View style={[styles.statValue, { color: theme.primary }]}>
                    {snapshot.threads.length}
                  </View>
                  <View style={[styles.statLabel, { color: theme.mutedForeground }]}>
                    Active Threads
                  </View>
                </View>
              </Card>
              <Card style={styles.statCard}>
                <View style={styles.stat}>
                  <View style={[styles.statValue, { color: theme.primary }]}>
                    {snapshot.projects.length}
                  </View>
                  <View style={[styles.statLabel, { color: theme.mutedForeground }]}>Projects</View>
                </View>
              </Card>
            </View>
          </>
        )}

        {/* Terminal Output */}
        {terminalOutput && (
          <>
            <SectionHeader title="Terminal Output" />
            <Card style={styles.terminalCard}>
              <View style={[styles.terminal, { backgroundColor: theme.surface }]}>
                {/* Terminal content would go here */}
              </View>
            </Card>
          </>
        )}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 0,
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusInfo: {
    flexDirection: "row",
  },
  statusDetail: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  statsGrid: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
  },
  statCard: {
    flex: 1,
    paddingVertical: 16,
  },
  stat: {
    alignItems: "center",
  },
  statValue: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  terminalCard: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 0,
    paddingVertical: 0,
    overflow: "hidden",
  },
  terminal: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 200,
    fontFamily: "Courier New",
  },
});
