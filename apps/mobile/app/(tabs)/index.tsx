import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, RefreshControl, StyleSheet, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Zap, ChevronRight, Plus, MessageSquare } from "lucide-react-native";
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
      const agentStats = resolveProjectAgentStats(snapshot, thread.projectId);
      if (agentStats.working > 0) return "running";
      return "ready";
    },
    [snapshot],
  );

  if (hosts.length === 0) {
    return (
      <View style={[styles.emptyRoot, { backgroundColor: colors.background }]}>
        <View style={styles.emptyContent}>
          <View style={[styles.emptyIcon, { backgroundColor: `${colors.primary}14` }]}>
            <Zap size={32} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Connect a Host</Text>
          <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
            Pair with an ace daemon to start controlling your AI agents remotely.
          </Text>
          <Pressable
            onPress={() => router.push("/pairing")}
            style={[styles.emptyButton, { backgroundColor: colors.secondaryGroupedBackground }]}
          >
            <Plus size={18} color={colors.primary} strokeWidth={2.5} />
            <Text style={[styles.emptyButtonText, { color: colors.foreground }]}>Pair Host</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
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

        {/* Stats */}
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
                      backgroundColor: isActive ? colors.primary : isDark ? "#2c2c2e" : "#e5e5ea",
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
                    style={[styles.chipLabel, { color: isActive ? "#fff" : colors.foreground }]}
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
        {threads.length === 0 ? (
          <View style={styles.emptyThreads}>
            <MessageSquare size={28} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyThreadsText, { color: colors.muted }]}>No threads yet</Text>
          </View>
        ) : (
          <View style={styles.threadList}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>RECENT THREADS</Text>
            {threads.map((thread, i) => {
              const status = threadStatus(thread);
              return (
                <Pressable
                  key={thread.id}
                  onPress={() =>
                    router.push({
                      pathname: "/thread/[threadId]",
                      params: { threadId: thread.id, hostId: activeHostId },
                    })
                  }
                  style={({ pressed }) => [styles.threadRow, pressed && { opacity: 0.6 }]}
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
                      numberOfLines={1}
                    >
                      {threadPreview(thread)}
                    </Text>
                    <Text style={[styles.threadMeta, { color: colors.muted }]}>
                      {thread.messages.length} msg · {formatTimeAgo(thread.updatedAt)}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                  {i < threads.length - 1 && (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  )}
                </Pressable>
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
  colors: { fill: string; foreground: string; muted: string };
}) {
  return (
    <View style={[styles.statPill, { backgroundColor: `${color}14` }]}>
      <Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.muted }]}>{label}</Text>
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
  emptyContent: { alignItems: "center", paddingHorizontal: 40 },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  emptyTitle: { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  emptySubtitle: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
  },
  emptyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
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
  statValue: { fontSize: 26, fontWeight: "700" },
  statLabel: { fontSize: 12, fontWeight: "500", marginTop: 2 },
  hostChips: { paddingHorizontal: 20, paddingVertical: 12, gap: 8 },
  hostChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 7,
  },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipLabel: { fontSize: 14, fontWeight: "600" },
  threadList: { paddingHorizontal: 20, paddingTop: 16 },
  sectionLabel: { fontSize: 12, fontWeight: "600", letterSpacing: 0.5, marginBottom: 12 },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 12,
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 34,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  threadContent: { flex: 1 },
  threadTitle: { fontSize: 16, fontWeight: "500", lineHeight: 21 },
  threadMeta: { fontSize: 13, marginTop: 2 },
  emptyThreads: { alignItems: "center", paddingVertical: 60, gap: 12 },
  emptyThreadsText: { fontSize: 15, fontWeight: "500" },
});
