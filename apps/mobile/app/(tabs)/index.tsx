import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, RefreshControl, StyleSheet, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight, FolderOpen, MessageSquare, Plus, Radio } from "lucide-react-native";
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
  ErrorBox,
} from "../../src/design/Components";
import { useOrchestrationSnapshot } from "../../src/hooks/useOrchestration";
import type { OrchestrationThread } from "@ace/contracts";
import { sortedCopy } from "../../src/sortedCopy";

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
        }));
      const sortedThreads = sortedCopy(threadsWithHost, (a, b) =>
        b.thread.updatedAt.localeCompare(a.thread.updatedAt),
      ).slice(0, 10);

      setRecentThreads(sortedThreads);
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
  const activeSessions = snapshot?.sessions.filter((session) => !session.closedAt).length ?? 0;
  const totalSessions = snapshot?.sessions.length ?? 0;
  const quickActions = useMemo(
    () => [
      {
        id: "threads",
        label: "Threads",
        Icon: MessageSquare,
        onPress: () => router.navigate("/(tabs)/chat"),
      },
      {
        id: "projects",
        label: "Projects",
        Icon: FolderOpen,
        onPress: () => router.navigate("/(tabs)/projects"),
      },
      {
        id: "pair",
        label: "Pair Host",
        Icon: Plus,
        onPress: () => router.push("/pairing"),
      },
    ],
    [router],
  );

  if (hosts.length === 0) {
    return (
      <SafeScreen>
        <View style={[styles.emptyContainer, { paddingTop: insets.top + 40 }]}>
          <View style={[styles.emptyIcon, { backgroundColor: isDark ? "#171922" : "#eef3ff" }]}>
            <Radio size={34} color={theme.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.foreground }]}>
            Connect your first host
          </Text>
          <Text style={[styles.emptySubtitle, { color: theme.mutedForeground }]}>
            Pair with an ace daemon to start sessions and control your agents.
          </Text>
          <Button
            title="Pair host"
            onPress={() => router.push("/pairing")}
            variant="primary"
            style={styles.primaryAction}
          />
        </View>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 8 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
        }
      >
        <ScreenHeader
          title="Overview"
          subtitle={`${connectedCount} active host${connectedCount === 1 ? "" : "s"}`}
        />

        {error && <ErrorBox message={error} onDismiss={() => setError(null)} />}

        <View style={styles.statsContainer}>
          <Card style={styles.statCard}>
            <Text style={[styles.statLabel, { color: theme.mutedForeground }]}>Sessions</Text>
            <Text style={[styles.statValue, { color: theme.foreground }]}>
              {activeSessions}
              <Text style={[styles.statMeta, { color: theme.mutedForeground }]}>
                {" "}
                / {totalSessions}
              </Text>
            </Text>
          </Card>
          <Card style={styles.statCard}>
            <Text style={[styles.statLabel, { color: theme.mutedForeground }]}>Hosts</Text>
            <Text style={[styles.statValue, { color: theme.foreground }]}>{connectedCount}</Text>
          </Card>
        </View>

        <SectionHeader title="Quick actions" />
        <View style={styles.quickActionGrid}>
          {quickActions.map(({ id, label, Icon, onPress }) => (
            <Pressable
              key={id}
              onPress={onPress}
              style={({ pressed }) => [
                styles.quickAction,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: `${theme.primary}1a` }]}>
                <Icon size={20} color={theme.primary} />
              </View>
              <Text style={[styles.quickActionLabel, { color: theme.foreground }]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <SectionHeader title="Recent threads" />
        {recentThreads.length === 0 ? (
          <Card style={styles.emptyCard}>
            <Text style={[styles.emptyCardText, { color: theme.mutedForeground }]}>
              No recent activity
            </Text>
          </Card>
        ) : (
          <List>
            {recentThreads.map(({ thread, hostId, hostName }) => (
              <ListItem
                key={`${hostId}-${thread.id}`}
                title={thread.messages.at(-1)?.text?.substring(0, 56) || "Untitled thread"}
                subtitle={hostName}
                onPress={() => router.push({ pathname: `/chat/${thread.id}`, params: { hostId } })}
                leftElement={
                  <View style={[styles.threadDot, { backgroundColor: `${theme.primary}22` }]}>
                    <MessageSquare size={14} color={theme.primary} />
                  </View>
                }
                rightElement={<ChevronRight size={18} color={theme.mutedForeground} />}
              />
            ))}
          </List>
        )}

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
    paddingHorizontal: 28,
  },
  emptyIcon: {
    width: 74,
    height: 74,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 26,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
  primaryAction: {
    marginTop: 24,
    minWidth: 180,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  statsContainer: {
    flexDirection: "row",
    gap: 12,
  },
  statCard: {
    flex: 1,
    minHeight: 104,
    justifyContent: "center",
  },
  statLabel: {
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 10,
  },
  statValue: {
    fontSize: 30,
    fontWeight: "700",
  },
  statMeta: {
    fontSize: 16,
    fontWeight: "500",
  },
  quickActionGrid: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
  },
  quickAction: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 94,
    padding: 12,
    justifyContent: "space-between",
  },
  quickActionIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  quickActionLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  emptyCard: {
    paddingVertical: 28,
    alignItems: "center",
  },
  emptyCardText: {
    fontSize: 15,
    fontWeight: "500",
  },
  threadDot: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
