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
      <View style={[styles.root, { backgroundColor: colors.groupedBackground }]}>
        <Stack.Screen options={{ headerShown: true, title: "" }} />
        <View style={styles.center}>
          <Text style={{ color: colors.muted }}>Host not found.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.groupedBackground }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: host.name,
          headerBackTitleVisible: false,
          headerStyle: { backgroundColor: colors.groupedBackground },
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
        {/* Connection Status Banner */}
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
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.muted }]}>
                PROJECTS ({projects.length})
              </Text>
            </View>
            <View
              style={[
                styles.groupContainer,
                { backgroundColor: colors.secondaryGroupedBackground },
              ]}
            >
              {projects.map((project, i) => {
                const stats = resolveProjectAgentStats(threads, project.id);
                return (
                  <React.Fragment key={project.id}>
                    {i > 0 && (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    )}
                    <View style={styles.projectRow}>
                      <View
                        style={[styles.projectIcon, { backgroundColor: `${colors.primary}18` }]}
                      >
                        <Text style={styles.projectEmoji}>📂</Text>
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
                  </React.Fragment>
                );
              })}
            </View>
          </>
        )}

        {/* Threads */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>
            THREADS ({threads.length})
          </Text>
        </View>

        {threads.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.secondaryGroupedBackground }]}>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              No threads yet. Start a conversation from the desktop app.
            </Text>
          </View>
        ) : (
          <View
            style={[styles.groupContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
          >
            {threads.map((thread, i) => {
              const { text: statusText, color: statusColor } = sessionStatusLabel(thread);
              return (
                <React.Fragment key={thread.id}>
                  {i > 0 && (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  )}
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: "/thread/[threadId]",
                        params: { threadId: thread.id, hostId: host.id },
                      })
                    }
                    style={({ pressed }) => [
                      styles.threadRow,
                      pressed && { backgroundColor: colors.fill },
                    ]}
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
  sectionHeader: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  groupContainer: {
    marginHorizontal: 20,
    borderRadius: 12,
    overflow: "hidden",
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  projectIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  projectEmoji: { fontSize: 18 },
  rowContent: { flex: 1 },
  projectName: { fontSize: 17, fontWeight: "500" },
  projectMeta: { fontSize: 14, marginTop: 2 },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  threadDot: { width: 10, height: 10, borderRadius: 5 },
  threadTitle: { fontSize: 17, fontWeight: "500" },
  threadMeta: { fontSize: 14, marginTop: 2 },
  chevron: { fontSize: 22, fontWeight: "300" },
  emptyCard: {
    marginHorizontal: 20,
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
  },
  emptyText: { fontSize: 15, textAlign: "center", lineHeight: 22 },
});
