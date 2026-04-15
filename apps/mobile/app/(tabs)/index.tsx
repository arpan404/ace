import React, { useEffect, useState, useCallback } from "react";
import { View, ScrollView, RefreshControl, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { Server } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { useUIStateStore } from "../../src/store/UIStateStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import {
  SafeScreen,
  ScreenHeader,
  SectionHeader,
  Card,
  List,
  ListItem,
  Button,
  StatusBadge,
  ErrorBox,
} from "../../src/design/Components";
import { useOrchestrationSnapshot } from "../../src/hooks/useOrchestration";
import type { OrchestrationThread } from "@ace/contracts";

export default function HomeScreen() {
  const router = useRouter();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const activeHostId = useUIStateStore((s) => s.activeHostId);
  const setActiveHostId = useUIStateStore((s) => s.setActiveHostId);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentThreads, setRecentThreads] = useState<
    Array<{ thread: OrchestrationThread; hostId: string; hostName: string }>
  >([]);

  // Auto-select first host if none selected
  useEffect(() => {
    if (!activeHostId && hosts.length > 0 && hosts[0]) {
      setActiveHostId(hosts[0].id);
    }
  }, [hosts, activeHostId, setActiveHostId]);

  const activeConnection = connections.find((c) => c.host.id === activeHostId);
  const { snapshot } = useOrchestrationSnapshot(activeConnection || null);

  useEffect(() => {
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
    });
  }, []);

  useEffect(() => {
    if (snapshot) {
      const threadsWithHost = snapshot.threads
        .filter((t) => !t.deletedAt)
        .map((t) => ({
          thread: t,
          hostId: activeConnection?.host.id || "",
          hostName: activeConnection?.host.name || "",
        }))
        .toSorted((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt))
        .slice(0, 10);

      setRecentThreads(threadsWithHost);
    }
  }, [snapshot, activeConnection]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      if (activeConnection && activeConnection.status.kind === "connected") {
        await activeConnection.client.orchestration.getSnapshot();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [activeConnection]);

  const connectedCount = connections.filter((c) => c.status.kind === "connected").length;
  const totalSessions = snapshot?.sessions.length || 0;
  const activeSessions = snapshot?.sessions.filter((s) => !s.closedAt).length || 0;

  if (hosts.length === 0) {
    return (
      <SafeScreen>
        <View style={[styles.emptyContainer, { paddingTop: insets.top + 40 }]}>
          <View
            style={[
              styles.emptyIcon,
              {
                backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
              },
            ]}
          >
            <Server size={48} color={theme.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.foreground }]}>No Hosts Connected</Text>
          <Text style={[styles.emptySubtitle, { color: theme.mutedForeground }]}>
            Pair your device with an ace daemon to get started.
          </Text>
          <Button
            title="Add Host"
            onPress={() => router.navigate("/(tabs)/settings")}
            variant="primary"
            style={{ marginTop: 24 }}
          />
        </View>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
        }
      >
        <ScreenHeader
          title="Dashboard"
          subtitle={`${connectedCount} connected ${connectedCount === 1 ? "host" : "hosts"}`}
          style={styles.header}
        />

        {error && <ErrorBox message={error} onDismiss={() => setError(null)} />}

        {/* Stats Cards */}
        <SectionHeader title="Status" />
        <View style={styles.statsContainer}>
          <Card
            style={[
              styles.statCard,
              {
                borderColor: theme.border,
                backgroundColor: theme.activeSurface,
              },
            ]}
          >
            <Text style={[styles.statLabel, { color: theme.mutedForeground }]}>
              Active Sessions
            </Text>
            <Text style={[styles.statValue, { color: theme.foreground }]}>
              {activeSessions}/{totalSessions}
            </Text>
          </Card>
          <Card
            style={[
              styles.statCard,
              {
                borderColor: theme.border,
                backgroundColor: theme.activeSurface,
              },
            ]}
          >
            <Text style={[styles.statLabel, { color: theme.mutedForeground }]}>
              Connected Hosts
            </Text>
            <Text style={[styles.statValue, { color: theme.foreground }]}>{connectedCount}</Text>
          </Card>
        </View>

        {/* Recent Threads */}
        <SectionHeader
          title="Recent Activity"
          action={
            <Button
              title="New"
              variant="primary"
              onPress={() => router.push("/chat")}
              style={styles.newButton}
            />
          }
        />

        {recentThreads.length === 0 ? (
          <Card
            style={[
              styles.emptyCard,
              {
                backgroundColor: theme.surface,
                borderColor: theme.border,
              },
            ]}
          >
            <Text style={[styles.emptyCardText, { color: theme.mutedForeground }]}>
              No recent activity
            </Text>
          </Card>
        ) : (
          <List>
            {recentThreads.map(({ thread, hostId, hostName }) => (
              <React.Fragment key={`${hostId}-${thread.id}`}>
                <ListItem
                  title={thread.messages.at(-1)?.text?.substring(0, 50) || "New Thread"}
                  subtitle={hostName}
                  onPress={() => router.push(`/chat/${thread.id}`)}
                  rightElement={
                    <StatusBadge status={thread.session?.closedAt ? "disconnected" : "connected"} />
                  }
                />
              </React.Fragment>
            ))}
          </List>
        )}

        {/* Quick Actions */}
        <SectionHeader title="Quick Actions" />
        <View style={styles.actionsContainer}>
          <Button
            title="New Thread"
            onPress={() => router.push("/chat")}
            variant="primary"
            style={styles.actionButton}
          />
          <Button
            title="View Projects"
            onPress={() => router.navigate("/(tabs)/projects")}
            variant="secondary"
            style={styles.actionButton}
          />
        </View>

        <View style={{ height: insets.bottom + 100 }} />
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: "center",
  },
  scrollContent: {
    paddingBottom: 32,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statsContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 12,
  },
  statCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  statLabel: {
    fontSize: 12,
    marginBottom: 8,
  },
  statValue: {
    fontSize: 24,
    fontWeight: "700",
  },
  newButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  emptyCard: {
    margin: 16,
    padding: 32,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
  },
  emptyCardText: {
    fontSize: 15,
  },
  actionsContainer: {
    paddingHorizontal: 16,
    gap: 12,
  },
  actionButton: {
    marginVertical: 6,
  },
});
