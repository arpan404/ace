import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight, FolderGit2, FolderOpen, Plus, RefreshCw, Search, Settings2 } from "lucide-react-native";
import { DEFAULT_MODEL_BY_PROVIDER, type FilesystemBrowseResult } from "@ace/contracts";
import { newCommandId, newProjectId } from "@ace/shared/ids";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import {
  ChoiceChip,
  EmptyState,
  FormField,
  IconButton,
  ListSkeleton,
  MetricCard,
  NoticeBanner,
  Panel,
  SearchField,
  ScreenBackdrop,
  GlassScreenHeader,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { useAggregatedOrchestration, formatTimeAgo } from "../../src/orchestration/mobileData";
import { useHostStore } from "../../src/store/HostStore";
import { useUIStateStore } from "../../src/store/UIStateStore";
import { formatErrorMessage } from "../../src/errors";
import { connectionManager } from "../../src/rpc/ConnectionManager";

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
  const [browsingProjectPath, setBrowsingProjectPath] = useState(false);
  const [projectBrowseResult, setProjectBrowseResult] = useState<FilesystemBrowseResult | null>(
    null,
  );
  const [projectBrowseLoadedPath, setProjectBrowseLoadedPath] = useState<string | null>(null);
  const [reconnectingHostId, setReconnectingHostId] = useState<string | null>(null);
  const [composerStep, setComposerStep] = useState<"path" | "details">("path");

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
  const activeHost = useMemo(() => {
    if (activeHostId) {
      return hosts.find((host) => host.id === activeHostId) ?? null;
    }
    return hosts[0] ?? null;
  }, [activeHostId, hosts]);
  const activeHostOffline =
    Boolean(activeHost) && (!activeConnection || activeConnection.status.kind !== "connected");

  const reconnectActiveHost = useCallback(async () => {
    if (!activeHost || reconnectingHostId) {
      return;
    }

    setReconnectingHostId(activeHost.id);
    setComposerError(null);
    try {
      const client = await connectionManager.connect(activeHost, { forceReconnect: true });
      await client.server.getConfig();
    } catch (cause) {
      setComposerError(formatErrorMessage(cause));
    } finally {
      setReconnectingHostId(null);
    }
  }, [activeHost, reconnectingHostId]);

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
      setComposerStep("path");
      setShowComposer(false);
      await refresh();
    } catch (cause) {
      setComposerError(formatErrorMessage(cause));
    } finally {
      setCreatingProject(false);
    }
  }, [activeConnection, newProjectPath, newProjectTitle, refresh]);

  const browseProjectPath = useCallback(
    async (partialPath?: string) => {
      if (!activeConnection || activeConnection.status.kind !== "connected") {
        setComposerError("Connect a host before browsing project folders.");
        return;
      }

      const browsePath = (partialPath ?? newProjectPath).trim() || "~";

      setBrowsingProjectPath(true);
      setComposerError(null);
      try {
        const result = await activeConnection.client.filesystem.browse({
          partialPath: browsePath,
        });
        setProjectBrowseResult(result);
        setProjectBrowseLoadedPath(browsePath);
      } catch (cause) {
        setProjectBrowseResult(null);
        setProjectBrowseLoadedPath(null);
        setComposerError(formatErrorMessage(cause));
      } finally {
        setBrowsingProjectPath(false);
      }
    },
    [activeConnection, newProjectPath],
  );

  const hasHosts = hosts.length > 0;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <GlassScreenHeader
        title="Projects"
        action={
          <View style={styles.headerActions}>
            <IconButton icon={Search} label="Search" onPress={() => router.push("/search")} />
            <IconButton
              icon={Plus}
              label="New"
              onPress={() =>
                setShowComposer((current) => {
                  const next = !current;
                  if (next) {
                    setComposerStep("path");
                  }
                  return next;
                })
              }
            />
            <IconButton icon={Settings2} label="Settings" onPress={() => router.push("/profile")} />
          </View>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 80,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        {hosts.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.hostStrip}
            style={styles.hostStripScroll}
          >
            {hosts.map((host) => {
              const isActive = host.id === activeHostId;
              return (
                <ChoiceChip
                  key={host.id}
                  label={host.name}
                  selected={isActive}
                  onPress={() => setActiveHostId(host.id)}
                />
              );
            })}
          </ScrollView>
        ) : null}

        <View style={styles.metricRow}>
          <MetricCard label="Projects" value={projects.length} tone="accent" />
          <MetricCard label="Online" value={connectedHostCount} tone="success" />
          <MetricCard
            label="Live target"
            value={activeConnection?.host.name ?? "None"}
            tone={activeConnection ? "muted" : "warning"}
          />
        </View>

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
        ) : loading ? (
          <ListSkeleton rows={5} />
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
                    transform: [{ scale: pressed ? 0.995 : 1 }],
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

        {error ? (
          <NoticeBanner tone="danger" title="Unable to refresh projects" body={error} />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  hostStripScroll: {
    marginTop: 12,
    marginBottom: 12,
  },
  hostStrip: {
    gap: 10,
  },
  metricRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  sectionHeader: {
    marginTop: 12,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 12,
    fontWeight: "700",
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
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "800",
    letterSpacing: -0.36,
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
});
