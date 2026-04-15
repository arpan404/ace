import React, { useEffect, useState } from "react";
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FolderOpen, ChevronRight, MessageSquare } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { useOrchestrationSnapshot } from "../../src/hooks/useOrchestration";
import { resolveProjectAgentStats } from "../../src/projectAgentStats";
import type { OrchestrationThread } from "@ace/contracts";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sessionStatusLabel(thread: OrchestrationThread): {
  text: string;
  color: "green" | "orange" | "muted" | "red";
} {
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return { text: "Running", color: "green" };
  if (status === "ready") return { text: "Ready", color: "orange" };
  if (status === "error") return { text: "Error", color: "red" };
  if (status === "interrupted") return { text: "Interrupted", color: "orange" };
  return { text: "Idle", color: "muted" };
}

export default function HostDetailScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const host = hosts.find((h) => h.id === hostId);

  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setConnections(connectionManager.getConnections());
    return connectionManager.onStatusChange(setConnections);
  }, []);

  const conn = connections.find((c) => c.host.id === hostId) ?? null;
  const { snapshot, loading } = useOrchestrationSnapshot(conn);

  const projects = snapshot?.projects.filter((p) => !p.deletedAt) ?? [];
  const threads = snapshot?.threads.filter((t) => !t.deletedAt) ?? [];
  const isConnected = conn?.status.kind === "connected";

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      if (conn?.status.kind === "connected") {
        await conn.client.orchestration.getSnapshot();
      }
    } finally {
      setRefreshing(false);
    }
  };

  if (!host) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: "" }} />
        <View style={styles.center}>
          <Text style={{ color: colors.muted }}>Host not found.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: host.name,
          headerBackTitleVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.foreground },
        }}
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary}
          />
        }
      >
        {/* Connection Status */}
        <View
          style={[
            styles.statusBanner,
            {
              backgroundColor: isConnected ? `${colors.green}14` : `${colors.red}14`,
            },
          ]}
        >
          <View
            style={[styles.statusDot, { backgroundColor: isConnected ? colors.green : colors.red }]}
          />
          <Text style={[styles.statusText, { color: isConnected ? colors.green : colors.red }]}>
            {isConnected ? "Connected" : "Disconnected"}
          </Text>
        </View>

        {loading && !snapshot ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}

        {/* Projects */}
        {projects.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>
              PROJECTS ({projects.length})
            </Text>
            {projects.map((project, i) => {
              const stats = resolveProjectAgentStats(threads, project.id);
              return (
                <View key={project.id}>
                  <View style={styles.projectRow}>
                    <View style={[styles.projectIcon, { backgroundColor: `${colors.primary}14` }]}>
                      <FolderOpen size={18} color={colors.primary} />
                    </View>
                    <View style={styles.rowContent}>
                      <Text
                        style={[styles.projectName, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {project.title}
                      </Text>
                      <Text style={[styles.projectMeta, { color: colors.muted }]}>
                        {stats.total} thread{stats.total !== 1 ? "s" : ""}
                        {stats.working > 0 ? ` · ${stats.working} active` : ""}
                      </Text>
                    </View>
                  </View>
                  {i < projects.length - 1 && (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  )}
                </View>
              );
            })}
          </>
        )}

        {/* Threads */}
        <Text
          style={[
            styles.sectionLabel,
            { color: colors.muted, marginTop: projects.length > 0 ? 24 : 0 },
          ]}
        >
          THREADS ({threads.length})
        </Text>

        {threads.length === 0 ? (
          <View style={styles.emptyThreads}>
            <MessageSquare size={28} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              No threads yet. Start a conversation from the desktop app.
            </Text>
          </View>
        ) : (
          threads.map((thread, i) => {
            const { text: statusText, color: statusColor } = sessionStatusLabel(thread);
            return (
              <View key={thread.id}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/thread/[threadId]",
                      params: { threadId: thread.id, hostId: host.id },
                    })
                  }
                  style={({ pressed }) => [styles.threadRow, pressed && { opacity: 0.6 }]}
                >
                  <View style={[styles.threadDot, { backgroundColor: colors[statusColor] }]} />
                  <View style={styles.rowContent}>
                    <Text
                      style={[styles.threadTitle, { color: colors.foreground }]}
                      numberOfLines={1}
                    >
                      {thread.title}
                    </Text>
                    <Text style={[styles.threadMeta, { color: colors.muted }]}>
                      {statusText} · {timeAgo(thread.updatedAt)}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                </Pressable>
                {i < threads.length - 1 && (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingWrap: { paddingVertical: 40, alignItems: "center" },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    marginHorizontal: 20,
    marginTop: 12,
    borderRadius: 10,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 15, fontWeight: "600" },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    marginTop: 24,
    marginBottom: 8,
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 50, marginRight: 20 },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 12,
  },
  projectIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: { flex: 1 },
  projectName: { fontSize: 17, fontWeight: "500" },
  projectMeta: { fontSize: 13, marginTop: 2 },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 12,
  },
  threadDot: { width: 10, height: 10, borderRadius: 5 },
  threadTitle: { fontSize: 17, fontWeight: "500" },
  threadMeta: { fontSize: 13, marginTop: 2 },
  emptyThreads: { alignItems: "center", paddingVertical: 40, gap: 12, paddingHorizontal: 32 },
  emptyText: { fontSize: 15, textAlign: "center", lineHeight: 22 },
});
