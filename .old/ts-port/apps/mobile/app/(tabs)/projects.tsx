import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FolderGit2, Plus, Search } from "lucide-react-native";
import { DEFAULT_MODEL_BY_PROVIDER } from "@ace/contracts";
import { newCommandId, newProjectId } from "@ace/shared/ids";
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
import { useAggregatedOrchestration, formatTimeAgo } from "../../src/orchestration/mobileData";
import { useHostStore } from "../../src/store/HostStore";
import { useUIStateStore } from "../../src/store/UIStateStore";
import { formatErrorMessage } from "../../src/errors";

export default function ProjectsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const hosts = useHostStore((state) => state.hosts);
  const activeHostId = useUIStateStore((state) => state.activeHostId);
  const setActiveHostId = useUIStateStore((state) => state.setActiveHostId);
  const { projects, loading, error, refresh, connections, connectedHostCount } =
    useAggregatedOrchestration();
  const [query, setQuery] = useState("");
  const [showComposer, setShowComposer] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  useEffect(() => {
    const hasActiveHost = activeHostId ? hosts.some((host) => host.id === activeHostId) : false;
    if (!hasActiveHost && hosts[0]) {
      setActiveHostId(hosts[0].id);
    }
  }, [activeHostId, hosts, setActiveHostId]);

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return projects;
    }

    return projects.filter((entry) => {
      const haystack = [entry.project.title, entry.hostName, entry.project.workspaceRoot]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [projects, query]);

  const activeConnection = useMemo(() => {
    if (activeHostId) {
      const active = connections.find((connection) => connection.host.id === activeHostId);
      if (active) {
        return active;
      }
    }
    return connections.find((connection) => connection.status.kind === "connected") ?? null;
  }, [activeHostId, connections]);

  const createProject = useCallback(async () => {
    if (!activeConnection || activeConnection.status.kind !== "connected") {
      setComposerError("Connect a host before creating a project.");
      return;
    }

    const workspaceRoot = newProjectPath.trim();
    if (workspaceRoot.length === 0) {
      setComposerError("Workspace path is required.");
      return;
    }

    const fallbackTitle =
      workspaceRoot.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? workspaceRoot;
    const title = newProjectTitle.trim() || fallbackTitle;

    setCreatingProject(true);
    setComposerError(null);
    try {
      await activeConnection.client.orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId: newProjectId(),
        title,
        workspaceRoot,
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        createdAt: new Date().toISOString(),
      });
      setNewProjectTitle("");
      setNewProjectPath("");
      setShowComposer(false);
      await refresh();
    } catch (cause) {
      setComposerError(formatErrorMessage(cause));
    } finally {
      setCreatingProject(false);
    }
  }, [activeConnection, newProjectPath, newProjectTitle, refresh]);

  const hasHosts = hosts.length > 0;

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
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <ScreenHeader
          eyebrow="ace"
          title="Projects"
          subtitle="Browse active workspaces, switch control targets, and launch new project roots."
          action={
            <IconButton
              icon={Plus}
              label="New"
              onPress={() => setShowComposer((current) => !current)}
            />
          }
        />

        <View
          style={[
            styles.searchShell,
            {
              backgroundColor: colors.surface,
              borderColor: colors.elevatedBorder,
              shadowColor: colors.shadow,
            },
          ]}
        >
          <Search size={17} color={colors.tertiaryLabel} strokeWidth={2.2} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search projects, hosts, or paths"
            placeholderTextColor={colors.muted}
            style={[styles.searchInput, { color: colors.foreground }]}
          />
        </View>

        {hosts.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.hostStrip}
          >
            {hosts.map((host) => {
              const isActive = host.id === activeHostId;
              const isConnected = connections.some(
                (connection) =>
                  connection.host.id === host.id && connection.status.kind === "connected",
              );

              return (
                <Pressable
                  key={host.id}
                  onPress={() => setActiveHostId(host.id)}
                  style={[
                    styles.hostChip,
                    {
                      backgroundColor: isActive ? colors.surface : colors.surfaceSecondary,
                      borderColor: isActive
                        ? withAlpha(colors.primary, 0.5)
                        : colors.elevatedBorder,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.hostDot,
                      {
                        backgroundColor: isConnected ? colors.green : colors.muted,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.hostChipLabel,
                      {
                        color: isActive ? colors.foreground : colors.secondaryLabel,
                      },
                    ]}
                  >
                    {host.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <View style={styles.metricRow}>
          <MetricCard label="Projects" value={projects.length} tone="accent" />
          <MetricCard label="Connected hosts" value={connectedHostCount} tone="success" />
          <MetricCard
            label="Live target"
            value={activeConnection?.host.name ?? "None"}
            tone={activeConnection ? "muted" : "warning"}
          />
        </View>

        {showComposer ? (
          <Panel>
            <View style={styles.composerHeader}>
              <SectionTitle>Create Project</SectionTitle>
              {activeConnection ? (
                <StatusBadge
                  label={`on ${activeConnection.host.name}`}
                  tone={activeConnection.status.kind === "connected" ? "success" : "warning"}
                />
              ) : null}
            </View>
            <TextInput
              value={newProjectPath}
              onChangeText={setNewProjectPath}
              placeholder="/absolute/path/to/project"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.textField,
                {
                  color: colors.foreground,
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
              ]}
            />
            <TextInput
              value={newProjectTitle}
              onChangeText={setNewProjectTitle}
              placeholder="Project name"
              placeholderTextColor={colors.muted}
              style={[
                styles.textField,
                {
                  color: colors.foreground,
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
              ]}
            />
            {composerError ? (
              <Text style={[styles.errorText, { color: colors.red }]}>{composerError}</Text>
            ) : null}
            <Pressable
              onPress={() => void createProject()}
              disabled={creatingProject}
              style={[
                styles.createButton,
                {
                  backgroundColor: colors.primary,
                },
                creatingProject && styles.disabled,
              ]}
            >
              <Text style={[styles.createButtonLabel, { color: colors.primaryForeground }]}>
                {creatingProject ? "Creating project…" : "Create project"}
              </Text>
            </Pressable>
          </Panel>
        ) : null}

        <View style={styles.sectionHeader}>
          <SectionTitle>Workspace Index</SectionTitle>
          {hasHosts ? (
            <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
              {filteredProjects.length} visible
            </Text>
          ) : null}
        </View>

        {!hasHosts ? (
          <EmptyState
            title="No paired hosts"
            body="Pair a desktop host in Settings before you create or browse projects."
            action={
              <IconButton icon={Plus} label="Pair host" onPress={() => router.push("/pairing")} />
            }
          />
        ) : filteredProjects.length === 0 ? (
          <EmptyState
            title={query.trim().length > 0 ? "No matching projects" : "No synced projects"}
            body={
              query.trim().length > 0
                ? "Try a different search term or switch to another connected host."
                : "Create your first project or wait for a connected host to sync workspace state."
            }
          />
        ) : (
          <Panel padded={false} style={styles.projectShell}>
            {filteredProjects.map((entry, index) => (
              <Pressable
                key={`${entry.hostId}-${entry.project.id}`}
                onPress={() =>
                  router.push({
                    pathname: "/project/[projectId]",
                    params: {
                      projectId: entry.project.id,
                      hostId: entry.hostId,
                    },
                  })
                }
                style={({ pressed }) => [
                  styles.projectRow,
                  {
                    backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
                  },
                ]}
              >
                <View
                  style={[
                    styles.projectIcon,
                    {
                      backgroundColor: withAlpha(colors.primary, 0.12),
                    },
                  ]}
                >
                  <FolderGit2 size={18} color={colors.primary} strokeWidth={2.1} />
                </View>
                <View style={styles.projectCopy}>
                  <View style={styles.projectTitleRow}>
                    <Text
                      style={[styles.projectTitle, { color: colors.foreground }]}
                      numberOfLines={1}
                    >
                      {entry.project.title}
                    </Text>
                    {entry.liveCount > 0 ? (
                      <StatusBadge label={`${entry.liveCount} live`} tone="success" />
                    ) : entry.pendingCount > 0 ? (
                      <StatusBadge label={`${entry.pendingCount} pending`} tone="warning" />
                    ) : (
                      <StatusBadge label={`${entry.completedCount} complete`} tone="muted" />
                    )}
                  </View>
                  <Text
                    style={[styles.projectMeta, { color: colors.secondaryLabel }]}
                    numberOfLines={1}
                  >
                    {entry.hostName} · {entry.threads.length} threads ·{" "}
                    {formatTimeAgo(entry.lastActivityAt)}
                  </Text>
                  <Text
                    style={[styles.projectPath, { color: colors.tertiaryLabel }]}
                    numberOfLines={1}
                  >
                    {entry.project.workspaceRoot}
                  </Text>
                </View>
                {index < filteredProjects.length - 1 ? (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                ) : null}
              </Pressable>
            ))}
          </Panel>
        )}

        {error ? <Text style={[styles.footerError, { color: colors.red }]}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  searchShell: {
    marginTop: 24,
    minHeight: 60,
    borderWidth: 1,
    borderRadius: Radius.card,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.12,
    shadowRadius: 30,
    elevation: 0,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "500",
  },
  hostStrip: {
    gap: 10,
    paddingTop: 16,
  },
  hostChip: {
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  hostDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  hostChipLabel: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
  metricRow: {
    marginTop: 18,
    flexDirection: "row",
    gap: 10,
  },
  composerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  textField: {
    marginTop: 14,
    minHeight: 56,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 16,
    fontSize: 15,
    fontWeight: "500",
  },
  errorText: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 18,
  },
  createButton: {
    marginTop: 16,
    minHeight: 54,
    borderRadius: Radius.card,
    alignItems: "center",
    justifyContent: "center",
  },
  createButtonLabel: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  disabled: {
    opacity: 0.7,
  },
  sectionHeader: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  projectShell: {
    overflow: "hidden",
  },
  projectRow: {
    minHeight: 110,
    paddingHorizontal: 18,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  projectIcon: {
    width: 44,
    height: 44,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  projectCopy: {
    flex: 1,
  },
  projectTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  projectTitle: {
    flex: 1,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  projectMeta: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  projectPath: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 17,
  },
  separator: {
    position: "absolute",
    left: 18,
    right: 18,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  footerError: {
    marginTop: 14,
    fontSize: 12,
    lineHeight: 18,
  },
});
