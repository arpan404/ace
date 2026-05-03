import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  View,
  ScrollView,
  StyleSheet,
  Text,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FolderOpen, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import {
  EmptyState,
  MetricCard,
  Panel,
  ScreenBackdrop,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { createHostInstance } from "../../src/hostInstances";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { useOrchestrationSnapshot } from "../../src/hooks/useOrchestration";
import { resolveProjectAgentStats } from "../../src/projectAgentStats";
import type { OrchestrationThread } from "@ace/contracts";
import { compareMobileThreads, formatTimeAgo } from "../../src/orchestration/mobileData";
import { useMobilePreferencesStore } from "../../src/store/MobilePreferencesStore";

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

function threadStatusTone(thread: OrchestrationThread): "success" | "warning" | "danger" | "muted" {
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return "success";
  if (status === "ready" || status === "interrupted") return "warning";
  if (status === "error") return "danger";
  return "muted";
}

export default function HostDetailScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const updateHost = useHostStore((s) => s.updateHost);
  const removeHost = useHostStore((s) => s.removeHost);
  const setActiveHost = useHostStore((s) => s.setActiveHost);
  const sidebarThreadSortOrder = useMobilePreferencesStore((state) => state.sidebarThreadSortOrder);
  const host = hosts.find((h) => h.id === hostId);
  const [hostNameInput, setHostNameInput] = useState("");
  const [hostWsUrlInput, setHostWsUrlInput] = useState("");
  const [hostTokenInput, setHostTokenInput] = useState("");

  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    setConnections(connectionManager.getConnections());
    return connectionManager.onStatusChange(setConnections);
  }, []);

  useEffect(() => {
    if (!host) {
      return;
    }
    setHostNameInput(host.name);
    setHostWsUrlInput(host.wsUrl);
    setHostTokenInput(host.authToken);
  }, [host]);

  const conn = connections.find((c) => c.host.id === hostId) ?? null;
  const { snapshot, loading, error, refresh } = useOrchestrationSnapshot(conn);

  const projects = snapshot?.projects.filter((p) => !p.deletedAt && !p.archivedAt) ?? [];
  const threads = useMemo(
    () =>
      (
        snapshot?.threads.filter((thread) => !thread.deletedAt && !thread.archivedAt) ?? []
      ).toSorted((left, right) => compareMobileThreads(left, right, sidebarThreadSortOrder)),
    [sidebarThreadSortOrder, snapshot?.threads],
  );
  const isConnected = conn?.status.kind === "connected";
  const connectionError =
    conn?.status.kind === "disconnected" && conn.status.error ? conn.status.error : null;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      if (conn?.status.kind === "connected") {
        await refresh();
      }
    } finally {
      setRefreshing(false);
    }
  };

  const onReconnect = async () => {
    if (!host || reconnecting) {
      return;
    }
    setReconnecting(true);
    try {
      const client = await connectionManager.connect(host, { forceReconnect: true });
      await client.server.getConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reconnect to this host.";
      Alert.alert("Reconnect failed", message);
    } finally {
      setReconnecting(false);
    }
  };

  if (!host) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ScreenBackdrop />
        <View style={[styles.missingWrap, { paddingTop: insets.top + 24 }]}>
          <Pressable
            onPress={() => router.back()}
            style={[
              styles.backButton,
              { backgroundColor: colors.surface, borderColor: colors.elevatedBorder },
            ]}
          >
            <ChevronLeft size={18} color={colors.foreground} strokeWidth={2.4} />
          </Pressable>
          <EmptyState title="Host not found" body="This paired host is no longer available." />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBackdrop />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 48,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={[
              styles.backButton,
              { backgroundColor: colors.surface, borderColor: colors.elevatedBorder },
            ]}
          >
            <ChevronLeft size={18} color={colors.foreground} strokeWidth={2.4} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={[styles.eyebrow, { color: colors.tertiaryLabel }]}>Host</Text>
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
              {host.name}
            </Text>
          </View>
          <StatusBadge
            label={isConnected ? "online" : "offline"}
            tone={isConnected ? "success" : connectionError ? "danger" : "muted"}
          />
        </View>

        <View style={styles.metricRow}>
          <MetricCard label="Projects" value={projects.length} tone="accent" />
          <MetricCard label="Threads" value={threads.length} tone="success" />
          <MetricCard
            label="Active"
            value={
              threads.filter((thread) => {
                const status = thread.session?.status;
                return status === "running" || status === "starting" || status === "ready";
              }).length
            }
            tone="warning"
          />
        </View>

        {!isConnected || connectionError ? (
          <Panel style={styles.statusPanel}>
            <View style={styles.statusCopy}>
              <Text style={[styles.statusText, { color: isConnected ? colors.green : colors.red }]}>
                {isConnected ? "Connected" : "Disconnected"}
              </Text>
              <Text
                style={[styles.statusError, { color: colors.secondaryLabel }]}
                numberOfLines={3}
              >
                {connectionError ?? "Reconnect this host to refresh projects and agent threads."}
              </Text>
            </View>
            {!isConnected ? (
              <Pressable
                disabled={reconnecting}
                onPress={() => void onReconnect()}
                accessibilityRole="button"
                accessibilityLabel="Reconnect host"
                style={({ pressed }) => [
                  styles.reconnectButton,
                  {
                    borderColor: withAlpha(colors.primary, 0.22),
                    backgroundColor: withAlpha(colors.primary, 0.12),
                  },
                  pressed && { opacity: 0.72 },
                  reconnecting && { opacity: 0.6 },
                ]}
              >
                {reconnecting ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <RefreshCw size={16} color={colors.primary} strokeWidth={2.3} />
                )}
                <Text style={[styles.reconnectButtonText, { color: colors.primary }]}>
                  Reconnect
                </Text>
              </Pressable>
            ) : null}
          </Panel>
        ) : null}

        <View style={styles.section}>
          <SectionTitle>Host Settings</SectionTitle>
          <Panel style={styles.editorCard}>
            <Text style={[styles.inputLabel, { color: colors.muted }]}>Name</Text>
            <TextInput
              value={hostNameInput}
              onChangeText={setHostNameInput}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  borderColor: colors.elevatedBorder,
                  backgroundColor: colors.surfaceSecondary,
                },
              ]}
              placeholder="My ace host"
              placeholderTextColor={colors.muted}
            />
            <Text style={[styles.inputLabel, { color: colors.muted }]}>WebSocket URL</Text>
            <TextInput
              value={hostWsUrlInput}
              onChangeText={setHostWsUrlInput}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  borderColor: colors.elevatedBorder,
                  backgroundColor: colors.surfaceSecondary,
                },
              ]}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ws://host:3773/ws"
              placeholderTextColor={colors.muted}
            />
            <Text style={[styles.inputLabel, { color: colors.muted }]}>Auth token (optional)</Text>
            <TextInput
              value={hostTokenInput}
              onChangeText={setHostTokenInput}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  borderColor: colors.elevatedBorder,
                  backgroundColor: colors.surfaceSecondary,
                },
              ]}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ACE_AUTH_TOKEN"
              placeholderTextColor={colors.muted}
              secureTextEntry
            />
            <View style={styles.editorActions}>
              <Pressable
                onPress={() => {
                  try {
                    const nextHost = createHostInstance(
                      {
                        name: hostNameInput,
                        wsUrl: hostWsUrlInput,
                        authToken: hostTokenInput,
                      },
                      host,
                    );
                    updateHost(nextHost);
                    setActiveHost(nextHost.id);
                  } catch (error) {
                    const message = error instanceof Error ? error.message : "Could not save host.";
                    Alert.alert("Invalid host configuration", message);
                  }
                }}
                style={({ pressed }) => [
                  styles.primaryAction,
                  { backgroundColor: colors.primary },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={[styles.primaryActionText, { color: colors.primaryForeground }]}>
                  Save Changes
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  Alert.alert("Delete host", "Remove this host from mobile?", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => {
                        removeHost(host.id);
                        router.back();
                      },
                    },
                  ]);
                }}
                style={({ pressed }) => [
                  styles.secondaryAction,
                  {
                    borderColor: withAlpha(colors.red, 0.22),
                    backgroundColor: withAlpha(colors.red, 0.08),
                  },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={[styles.secondaryActionText, { color: colors.red }]}>Delete Host</Text>
              </Pressable>
            </View>
          </Panel>
        </View>

        {loading && !snapshot ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}

        {error ? <Text style={[styles.errorText, { color: colors.red }]}>{error}</Text> : null}

        {projects.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <SectionTitle>Projects</SectionTitle>
              <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
                {projects.length} total
              </Text>
            </View>
            <Panel padded={false} style={styles.listShell}>
              {projects.map((project, i) => {
                const stats = resolveProjectAgentStats(threads, project.id);
                return (
                  <View key={project.id}>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: "/project/[projectId]",
                          params: { projectId: project.id, hostId: host.id },
                        })
                      }
                      style={({ pressed }) => [
                        styles.projectRow,
                        {
                          backgroundColor: pressed
                            ? withAlpha(colors.foreground, 0.04)
                            : "transparent",
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.projectIcon,
                          { backgroundColor: withAlpha(colors.primary, 0.12) },
                        ]}
                      >
                        <FolderOpen size={18} color={colors.primary} strokeWidth={2.2} />
                      </View>
                      <View style={styles.rowContent}>
                        <Text
                          style={[styles.projectName, { color: colors.foreground }]}
                          numberOfLines={1}
                        >
                          {project.title}
                        </Text>
                        <Text style={[styles.projectMeta, { color: colors.secondaryLabel }]}>
                          {stats.total} thread{stats.total !== 1 ? "s" : ""}
                          {stats.working > 0 ? ` · ${stats.working} active` : ""}
                        </Text>
                      </View>
                      <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                    </Pressable>
                    {i < projects.length - 1 && (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    )}
                  </View>
                );
              })}
            </Panel>
          </View>
        )}

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Threads</SectionTitle>
            <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
              {threads.length} total
            </Text>
          </View>

          {threads.length === 0 ? (
            <EmptyState
              title="No threads yet"
              body="Threads from this host will appear here once agent work starts."
            />
          ) : (
            <Panel padded={false} style={styles.listShell}>
              {threads.map((thread, i) => {
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
                      style={({ pressed }) => [
                        styles.threadRow,
                        {
                          backgroundColor: pressed
                            ? withAlpha(colors.foreground, 0.04)
                            : "transparent",
                        },
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
                        <View style={styles.threadMetaRow}>
                          <StatusBadge label={statusText} tone={threadStatusTone(thread)} />
                          <Text style={[styles.threadMeta, { color: colors.secondaryLabel }]}>
                            {statusText} · {formatTimeAgo(thread.updatedAt)}
                          </Text>
                        </View>
                      </View>
                      <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                    </Pressable>
                    {i < threads.length - 1 && (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    )}
                  </View>
                );
              })}
            </Panel>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  missingWrap: {
    flex: 1,
    paddingHorizontal: Layout.pagePadding,
    gap: 18,
  },
  header: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "800",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 4,
    fontSize: 30,
    lineHeight: 33,
    fontWeight: "900",
    letterSpacing: -0.9,
  },
  metricRow: {
    marginTop: 18,
    flexDirection: "row",
    gap: 10,
  },
  loadingWrap: { paddingVertical: 40, alignItems: "center" },
  errorText: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: "600",
  },
  section: {
    marginTop: 24,
    gap: 10,
  },
  sectionHeader: {
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
  listShell: {
    overflow: "hidden",
  },
  editorCard: {
    gap: 8,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: Radius.input,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  editorActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  primaryAction: {
    flex: 1,
    minHeight: 46,
    borderRadius: Radius.input,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  primaryActionText: {
    fontSize: 14,
    fontWeight: "700",
  },
  secondaryAction: {
    flex: 1,
    minHeight: 46,
    borderRadius: Radius.input,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  secondaryActionText: {
    fontSize: 14,
    fontWeight: "700",
  },
  statusPanel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 18,
  },
  statusCopy: { flex: 1, minWidth: 0 },
  statusText: { fontSize: 15, lineHeight: 19, fontWeight: "900" },
  statusError: { fontSize: 12, lineHeight: 17, marginTop: 5, fontWeight: "600" },
  reconnectButton: {
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  reconnectButtonText: { fontSize: 14, fontWeight: "700" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 66, marginRight: 18 },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 76,
    paddingVertical: 14,
    paddingHorizontal: 18,
    gap: 12,
  },
  projectIcon: {
    width: 38,
    height: 38,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: { flex: 1, minWidth: 0 },
  projectName: { fontSize: 17, lineHeight: 21, fontWeight: "800", letterSpacing: -0.25 },
  projectMeta: { fontSize: 13, lineHeight: 18, marginTop: 3, fontWeight: "600" },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 78,
    paddingVertical: 14,
    paddingHorizontal: 18,
    gap: 12,
  },
  threadDot: { width: 10, height: 10, borderRadius: 5 },
  threadTitle: { fontSize: 17, lineHeight: 21, fontWeight: "800", letterSpacing: -0.25 },
  threadMetaRow: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  threadMeta: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: "600" },
});
