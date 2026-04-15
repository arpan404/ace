import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, RefreshControl, StyleSheet, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { useUIStateStore } from "../../src/store/UIStateStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { useOrchestrationSnapshot } from "../../src/hooks/useOrchestration";
import type { OrchestrationThread } from "@ace/contracts";
import { sortedCopy } from "../../src/sortedCopy";
import { resolveProjectAgentStats } from "../../src/projectAgentStats";

export default function AgentsScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const activeHostId = useUIStateStore((s) => s.activeHostId);
  const setActiveHostId = useUIStateStore((s) => s.setActiveHostId);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!activeHostId && hosts.length > 0 && hosts[0]) {
      setActiveHostId(hosts[0].id);
    }
  }, [hosts, activeHostId, setActiveHostId]);

  const activeConnection = connections.find((c) => c.host.id === activeHostId);
  const { snapshot } = useOrchestrationSnapshot(activeConnection ?? null);

  useEffect(() => connectionManager.onStatusChange(setConnections), []);

  const connectedCount = connections.filter((c) => c.status.kind === "connected").length;

  const threads = useMemo(() => {
    if (!snapshot) return [];
    return sortedCopy(
      snapshot.threads.filter((t) => !t.deletedAt),
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [snapshot]);

  const stats = useMemo(() => {
    if (!snapshot) return { active: 0, total: 0, projects: 0 };
    const activeSessions = snapshot.sessions.filter((s) => !s.closedAt).length;
    return {
      active: activeSessions,
      total: snapshot.threads.length,
      projects: snapshot.projects.filter((p) => !p.deletedAt).length,
    };
  }, [snapshot]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (activeConnection?.status.kind === "connected") {
        await activeConnection.client.orchestration.getSnapshot();
      }
    } finally {
      setRefreshing(false);
    }
  }, [activeConnection]);

  const threadPreview = useCallback((thread: OrchestrationThread) => {
    const lastMsg = thread.messages.at(-1);
    return lastMsg?.text?.substring(0, 80) ?? "New thread";
  }, []);

  const threadStatus = useCallback(
    (thread: OrchestrationThread) => {
      if (!snapshot) return "idle";
      const session = snapshot.sessions.find((s) => s.threadId === thread.id && !s.closedAt);
      if (!session) return "idle";
      const stats = resolveProjectAgentStats(snapshot, thread.projectId);
      if (stats.working > 0) return "running";
      return "ready";
    },
    [snapshot],
  );

  if (hosts.length === 0) {
    return (
      <View style={[styles.emptyRoot, { backgroundColor: colors.background }]}>
        <View style={styles.emptyContent}>
          <View style={[styles.emptyIcon, { backgroundColor: isDark ? "#1c1c1e" : "#e5e5ea" }]}>
            <Text style={styles.emptyIconText}>⚡</Text>
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Connect a Host</Text>
          <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
            Pair with an ace daemon to start controlling your AI agents remotely.
          </Text>
          <Pressable
            onPress={() => router.push("/pairing")}
            style={[styles.emptyButton, { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.emptyButtonText, { color: colors.primaryForeground }]}>
              Pair Host
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.groupedBackground }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + 100 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.largeTitle, { color: colors.foreground }]}>Agents</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {connectedCount} host{connectedCount !== 1 ? "s" : ""} connected
          </Text>
        </View>

        {/* Stats Row */}
        <View style={styles.statsRow}>
          <StatPill label="Active" value={stats.active} color={colors.green} colors={colors} />
          <StatPill label="Threads" value={stats.total} color={colors.primary} colors={colors} />
          <StatPill label="Projects" value={stats.projects} color={colors.orange} colors={colors} />
        </View>

        {/* Host Switcher */}
        {hosts.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.hostChips}
          >
            {hosts.map((host) => {
              const isActive = host.id === activeHostId;
              const conn = connections.find((c) => c.host.id === host.id);
              const isConnected = conn?.status.kind === "connected";
              return (
                <Pressable
                  key={host.id}
                  onPress={() => setActiveHostId(host.id)}
                  style={[
                    styles.hostChip,
                    {
                      backgroundColor: isActive
                        ? colors.primary
                        : colors.secondaryGroupedBackground,
                      borderColor: isActive ? colors.primary : colors.separator,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.chipDot,
                      { backgroundColor: isConnected ? colors.green : colors.muted },
                    ]}
                  />
                  <Text
                    style={[
                      styles.chipLabel,
                      { color: isActive ? colors.primaryForeground : colors.foreground },
                    ]}
                    numberOfLines={1}
                  >
                    {host.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {/* Thread List */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>
            {threads.length > 0 ? "RECENT THREADS" : "NO THREADS YET"}
          </Text>
        </View>

        {threads.length === 0 ? (
          <View style={[styles.emptyState, { backgroundColor: colors.secondaryGroupedBackground }]}>
            <Text style={[styles.emptyStateText, { color: colors.muted }]}>
              Start a new thread from your desktop to see it here.
            </Text>
          </View>
        ) : (
          <View
            style={[styles.listContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
          >
            {threads.map((thread, i) => {
              const status = threadStatus(thread);
              return (
                <React.Fragment key={thread.id}>
                  {i > 0 && (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  )}
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: "/thread/[threadId]",
                        params: { threadId: thread.id, hostId: activeHostId },
                      })
                    }
                    style={({ pressed }) => [
                      styles.threadRow,
                      pressed && { backgroundColor: colors.fill },
                    ]}
                  >
                    <View
                      style={[
                        styles.statusDot,
                        {
                          backgroundColor:
                            status === "running"
                              ? colors.green
                              : status === "ready"
                                ? colors.orange
                                : colors.muted,
                        },
                      ]}
                    />
                    <View style={styles.threadContent}>
                      <Text
                        style={[styles.threadTitle, { color: colors.foreground }]}
                        numberOfLines={2}
                      >
                        {threadPreview(thread)}
                      </Text>
                      <Text style={[styles.threadMeta, { color: colors.muted }]}>
                        {thread.messages.length} message{thread.messages.length !== 1 ? "s" : ""} ·{" "}
                        {formatTimeAgo(thread.updatedAt)}
                      </Text>
                    </View>
                    <Text style={[styles.chevron, { color: colors.separator }]}>›</Text>
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function StatPill({
  label,
  value,
  color,
  colors,
}: {
  label: string;
  value: number;
  color: string;
  colors: { secondaryGroupedBackground: string; foreground: string; muted: string };
}) {
  return (
    <View style={[styles.statPill, { backgroundColor: colors.secondaryGroupedBackground }]}>
      <Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text>
      <View style={styles.statLabelRow}>
        <View style={[styles.statDot, { backgroundColor: color }]} />
        <Text style={[styles.statLabel, { color: colors.muted }]}>{label}</Text>
      </View>
    </View>
  );
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  emptyRoot: { flex: 1, justifyContent: "center" },
  emptyContent: { alignItems: "center", paddingHorizontal: 32 },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  emptyIconText: { fontSize: 36 },
  emptyTitle: { fontSize: 28, fontWeight: "700", marginBottom: 8 },
  emptySubtitle: {
    fontSize: 16,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
  },
  emptyButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 14,
  },
  emptyButtonText: { fontSize: 17, fontWeight: "600" },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  largeTitle: { fontSize: 34, fontWeight: "700", letterSpacing: 0.37 },
  subtitle: { fontSize: 15, marginTop: 2 },
  statsRow: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 10,
  },
  statPill: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  statValue: { fontSize: 28, fontWeight: "700" },
  statLabelRow: { flexDirection: "row", alignItems: "center", marginTop: 4, gap: 5 },
  statDot: { width: 8, height: 8, borderRadius: 4 },
  statLabel: { fontSize: 13, fontWeight: "500" },
  hostChips: { paddingHorizontal: 20, paddingVertical: 12, gap: 8 },
  hostChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    gap: 7,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipLabel: { fontSize: 14, fontWeight: "600" },
  sectionHeader: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  listContainer: { marginHorizontal: 20, borderRadius: 12, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  threadContent: { flex: 1 },
  threadTitle: { fontSize: 16, fontWeight: "500", lineHeight: 21 },
  threadMeta: { fontSize: 13, marginTop: 3 },
  chevron: { fontSize: 22, fontWeight: "300" },
  emptyState: {
    marginHorizontal: 20,
    borderRadius: 12,
    paddingVertical: 40,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  emptyStateText: { fontSize: 15, textAlign: "center", lineHeight: 22 },
});
