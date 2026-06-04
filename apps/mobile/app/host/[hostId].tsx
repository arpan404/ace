import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, FolderOpen, RefreshCw, Server, Star, Trash2 } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius } from "../../src/design/system";
import {
  ActionRow,
  DetailRow,
  EmptyState,
  FormField,
  IconButton,
  InsetGroup,
  InsetRow,
  NoticeBanner,
  Panel,
  ScreenBackdrop,
  ScreenHeaderV2,
  SectionFooter,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { createHostInstance } from "../../src/hostInstances";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { useOrchestrationSnapshot } from "../../src/hooks/useOrchestration";
import { resolveProjectAgentStats } from "../../src/projectAgentStats";
import { compareMobileThreads, formatTimeAgo } from "../../src/orchestration/mobileData";
import { useMobilePreferencesStore } from "../../src/store/MobilePreferencesStore";
import { formatErrorMessage } from "../../src/errors";
import { sortedCopy } from "../../src/sortedCopy";

function statusTone(isConnected: boolean, error: string | null) {
  if (isConnected) {
    return "success" as const;
  }
  if (error) {
    return "danger" as const;
  }
  return "muted" as const;
}

export default function HostDetailScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const hosts = useHostStore((state) => state.hosts);
  const activeHostId = useHostStore((state) => state.activeHostId);
  const updateHost = useHostStore((state) => state.updateHost);
  const removeHost = useHostStore((state) => state.removeHost);
  const setActiveHost = useHostStore((state) => state.setActiveHost);
  const sidebarThreadSortOrder = useMobilePreferencesStore((state) => state.sidebarThreadSortOrder);
  const host = hosts.find((candidate) => candidate.id === hostId) ?? null;
  const [connections, setConnections] = useState<ReadonlyArray<ManagedConnection>>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [wsUrlDraft, setWsUrlDraft] = useState("");
  const [authTokenDraft, setAuthTokenDraft] = useState("");
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
    setNameDraft(host.name);
    setWsUrlDraft(host.wsUrl);
    setAuthTokenDraft(host.authToken);
  }, [host]);

  const connection = useMemo(
    () => connections.find((candidate) => candidate.host.id === hostId) ?? null,
    [connections, hostId],
  );
  const { snapshot, loading, error, refresh } = useOrchestrationSnapshot(connection);

  const projects =
    snapshot?.projects.filter((project) => !project.deletedAt && !project.archivedAt) ?? [];
  const threads = useMemo(
    () =>
      sortedCopy(
        snapshot?.threads.filter((thread) => !thread.deletedAt && !thread.archivedAt) ?? [],
        (left, right) => compareMobileThreads(left, right, sidebarThreadSortOrder),
      ),
    [sidebarThreadSortOrder, snapshot?.threads],
  );

  const isConnected = connection?.status.kind === "connected";
  const connectionError =
    connection?.status.kind === "disconnected" && connection.status.error
      ? connection.status.error
      : null;
  const hasDraftChanges =
    !!host &&
    (nameDraft.trim() !== host.name ||
      wsUrlDraft.trim() !== host.wsUrl ||
      authTokenDraft.trim() !== host.authToken);

  const handleRefresh = async () => {
    if (!connection || connection.status.kind !== "connected") {
      return;
    }
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const handleReconnect = async () => {
    if (!host || reconnecting) {
      return;
    }
    setReconnecting(true);
    try {
      const client = await connectionManager.connect(host, { forceReconnect: true });
      await client.server.getConfig();
      if (connection?.status.kind === "connected") {
        await refresh();
      }
    } catch (cause) {
      Alert.alert("Reconnect failed", formatErrorMessage(cause));
    } finally {
      setReconnecting(false);
    }
  };

  const handleSave = () => {
    if (!host || !hasDraftChanges) {
      return;
    }
    try {
      const nextHost = createHostInstance(
        {
          name: nameDraft.trim(),
          wsUrl: wsUrlDraft.trim(),
          authToken: authTokenDraft.trim(),
        },
        host,
      );
      updateHost(nextHost);
      setActiveHost(nextHost.id);
    } catch (cause) {
      Alert.alert("Invalid host configuration", formatErrorMessage(cause));
    }
  };

  const handleRemove = () => {
    if (!host) {
      return;
    }
    Alert.alert("Remove host", `Remove ${host.name} from mobile?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          removeHost(host.id);
          router.replace("/settings");
        },
      },
    ]);
  };

  if (!host) {
    return (
      <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ScreenBackdrop />
        <View style={[styles.missingWrap, { paddingTop: insets.top + 24 }]}>
          <IconButton icon={ChevronLeft} label="Back" onPress={() => router.back()} />
          <EmptyState title="Host not found" body="This paired host is no longer available." />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 48,
          gap: 22,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} />
        }
      >
        <ScreenHeaderV2
          eyebrow="Host"
          title={host.name}
          subtitle="Connection details, synced workspaces, and host-specific actions."
          actions={
            <View style={styles.headerActions}>
              <StatusBadge
                label={isConnected ? "Connected" : "Offline"}
                tone={statusTone(Boolean(isConnected), connectionError)}
              />
              <IconButton icon={ChevronLeft} label="Back" onPress={() => router.back()} />
            </View>
          }
        />

        <View style={styles.section}>
          <SectionTitle>Overview</SectionTitle>
          <InsetGroup>
            <DetailRow
              label="Status"
              value={isConnected ? "Connected" : "Offline"}
              tone={statusTone(Boolean(isConnected), connectionError)}
            />
            <DetailRow label="Projects" value={String(projects.length)} />
            <DetailRow label="Threads" value={String(threads.length)} />
            <DetailRow label="Default host" value={activeHostId === host.id ? "Yes" : "No"} last />
          </InsetGroup>
          {connectionError ? (
            <SectionFooter>{connectionError}</SectionFooter>
          ) : (
            <SectionFooter>
              Pull to refresh when the host is connected. Offline hosts can be reconnected from the
              actions section.
            </SectionFooter>
          )}
        </View>

        <View style={styles.section}>
          <SectionTitle>Connection</SectionTitle>
          <InsetGroup>
            <DetailRow label="WebSocket URL" value={host.wsUrl} mono />
            <DetailRow label="Session ID" value={host.clientSessionId} mono selectable last />
          </InsetGroup>
        </View>

        <View style={styles.section}>
          <SectionTitle>Configuration</SectionTitle>
          <Panel style={styles.formPanel}>
            <FormField
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="Host name"
              autoCapitalize="words"
              autoCorrect={false}
            />
            <FormField
              value={wsUrlDraft}
              onChangeText={setWsUrlDraft}
              placeholder="ws://host:3773/ws"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <FormField
              value={authTokenDraft}
              onChangeText={setAuthTokenDraft}
              placeholder="Optional token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Pressable
              onPress={handleSave}
              disabled={!hasDraftChanges}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor: hasDraftChanges ? colors.accent.primary : colors.surfaces.muted,
                  borderColor: hasDraftChanges ? colors.accent.primary : colors.border.soft,
                  opacity: pressed ? 0.7 : 1,
                },
                !hasDraftChanges && styles.disabled,
              ]}
            >
              <Text
                style={[
                  styles.primaryButtonText,
                  { color: hasDraftChanges ? colors.text.inverse : colors.text.tertiary },
                ]}
              >
                Save host
              </Text>
            </Pressable>
          </Panel>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Projects</SectionTitle>
            <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
              {projects.length}
            </Text>
          </View>
          {loading && !snapshot ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={colors.accent.primary} />
            </View>
          ) : projects.length === 0 ? (
            <EmptyState
              title="No synced projects"
              body="Projects will appear here after this host connects and workspace state syncs."
            />
          ) : (
            <InsetGroup>
              {projects.map((project, index) => {
                const stats = resolveProjectAgentStats(threads, project.id);
                return (
                  <InsetRow
                    key={project.id}
                    title={project.title}
                    meta={`${stats.total} threads${stats.working > 0 ? ` · ${stats.working} active` : ""}`}
                    icon={FolderOpen}
                    onPress={() =>
                      router.push({
                        pathname: "/project/[projectId]",
                        params: { projectId: project.id, hostId: host.id },
                      })
                    }
                    last={index === projects.length - 1}
                  />
                );
              })}
            </InsetGroup>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Threads</SectionTitle>
            <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
              {threads.length}
            </Text>
          </View>
          {threads.length === 0 ? (
            <EmptyState
              title="No threads yet"
              body="Start agent work from a project and active threads will appear here."
            />
          ) : (
            <InsetGroup>
              {threads.map((thread, index) => (
                <InsetRow
                  key={thread.id}
                  title={thread.title}
                  meta={formatTimeAgo(thread.updatedAt)}
                  icon={Server}
                  tone={
                    thread.session?.status === "error"
                      ? "danger"
                      : thread.session?.status === "running" ||
                          thread.session?.status === "starting"
                        ? "success"
                        : thread.session?.status === "ready" ||
                            thread.session?.status === "interrupted"
                          ? "warning"
                          : "muted"
                  }
                  onPress={() =>
                    router.push({
                      pathname: "/thread/[threadId]",
                      params: { threadId: thread.id, hostId: host.id },
                    })
                  }
                  trailing={
                    <StatusBadge
                      label={thread.session?.status ?? "idle"}
                      tone={
                        thread.session?.status === "error"
                          ? "danger"
                          : thread.session?.status === "running" ||
                              thread.session?.status === "starting"
                            ? "success"
                            : thread.session?.status === "ready" ||
                                thread.session?.status === "interrupted"
                              ? "warning"
                              : "muted"
                      }
                    />
                  }
                  last={index === threads.length - 1}
                />
              ))}
            </InsetGroup>
          )}
        </View>

        <View style={styles.section}>
          <SectionTitle>Actions</SectionTitle>
          <InsetGroup>
            <ActionRow
              title={activeHostId === host.id ? "Default host" : "Make default host"}
              icon={Star}
              onPress={() => setActiveHost(host.id)}
              disabled={activeHostId === host.id}
            />
            <ActionRow
              title={reconnecting ? "Reconnecting host" : "Reconnect host"}
              icon={RefreshCw}
              onPress={() => void handleReconnect()}
              disabled={reconnecting}
            />
            <ActionRow
              title="Remove host"
              tone="danger"
              icon={Trash2}
              onPress={handleRemove}
              last
            />
          </InsetGroup>
        </View>

        {error ? (
          <NoticeBanner tone="danger" title="Unable to refresh host data" body={error} />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  missingWrap: {
    flex: 1,
    gap: 18,
    paddingHorizontal: Layout.pagePadding,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  section: {
    gap: 10,
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 12,
  },
  formPanel: {
    gap: 10,
  },
  primaryButton: {
    alignItems: "center",
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: "600",
  },
  loadingWrap: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 96,
  },
  disabled: {
    opacity: 0.58,
  },
});
