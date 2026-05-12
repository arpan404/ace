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
import {
  Check,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react-native";
import Animated from "react-native-reanimated";
import { DEFAULT_MODEL_BY_PROVIDER, type FilesystemBrowseResult } from "@ace/contracts";
import { newCommandId, newProjectId } from "@ace/shared/ids";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { enterRow, exitRow, layoutTransition } from "../../src/design/motion";
import {
  EmptyState,
  FormField,
  IconButton,
  InsetGroup,
  InsetRow,
  ListSkeleton,
  NoticeBanner,
  Panel,
  SearchField,
  ScreenBackdrop,
  ScreenHeaderV2,
  SectionFooter,
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
  const [browsingProjectPath, setBrowsingProjectPath] = useState(false);
  const [projectBrowseResult, setProjectBrowseResult] = useState<FilesystemBrowseResult | null>(
    null,
  );
  const [projectBrowseLoadedPath, setProjectBrowseLoadedPath] = useState<string | null>(null);
  const [composerStep, setComposerStep] = useState<"path" | "details">("path");
  const [selectedHostFilter, setSelectedHostFilter] = useState<string>("all");

  useEffect(() => {
    const hasActiveHost = activeHostId ? hosts.some((host) => host.id === activeHostId) : false;
    if (!hasActiveHost && hosts[0]) {
      setActiveHostId(hosts[0].id);
    }
  }, [activeHostId, hosts, setActiveHostId]);

  useEffect(() => {
    if (selectedHostFilter === "all") {
      return;
    }
    if (!hosts.some((host) => host.id === selectedHostFilter)) {
      setSelectedHostFilter("all");
    }
  }, [hosts, selectedHostFilter]);

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return projects.filter((entry) => {
      if (selectedHostFilter !== "all" && entry.hostId !== selectedHostFilter) {
        return false;
      }
      if (normalizedQuery.length === 0) {
        return true;
      }
      const haystack = [entry.project.title, entry.hostName, entry.project.workspaceRoot]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [projects, query, selectedHostFilter]);

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
  const selectedHostName =
    selectedHostFilter === "all"
      ? "All hosts"
      : (hosts.find((host) => host.id === selectedHostFilter)?.name ?? "Selected host");

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
    <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 14,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <ScreenHeaderV2
          title="Projects"
          subtitle="Workspace roots and project activity across your connected environments."
          actions={
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
                tone="primary"
              />
              <IconButton
                icon={SlidersHorizontal}
                label="Settings"
                onPress={() => router.push("/settings")}
              />
            </View>
          }
        />

        {activeHostOffline && activeHost ? (
          <NoticeBanner
            tone="warning"
            title={`${activeHost.name} is offline`}
            body="Reconnect this host to browse directories or create a project on it."
          />
        ) : null}

        <View style={styles.searchWrap}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Filter by project, host, or path"
            icon={Search}
          />
        </View>

        {hosts.length > 0 ? (
          <View style={styles.scopeSection}>
            <View style={styles.sectionHeader}>
              <SectionTitle>Host Scope</SectionTitle>
              <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
                {selectedHostName}
              </Text>
            </View>
            <InsetGroup>
              <InsetRow
                title="All hosts"
                meta="Show projects from every paired environment."
                trailing={
                  selectedHostFilter === "all" ? (
                    <Check size={16} color={colors.accent.primary} strokeWidth={2.4} />
                  ) : undefined
                }
                onPress={() => setSelectedHostFilter("all")}
              />
              {hosts.map((host, index) => (
                <InsetRow
                  key={host.id}
                  title={host.name}
                  meta={host.wsUrl}
                  trailing={
                    selectedHostFilter === host.id ? (
                      <Check size={16} color={colors.accent.primary} strokeWidth={2.4} />
                    ) : undefined
                  }
                  onPress={() => {
                    setSelectedHostFilter(host.id);
                    setActiveHostId(host.id);
                  }}
                  last={index === hosts.length - 1}
                />
              ))}
            </InsetGroup>
            <SectionFooter>
              New projects are created on the current host target. Filter scope only changes this
              list.
            </SectionFooter>
          </View>
        ) : null}

        {showComposer ? (
          <Panel style={styles.composerPanel}>
            <View style={styles.composerHeader}>
              <View style={styles.composerHeaderCopy}>
                <SectionTitle>
                  {composerStep === "path" ? "New project" : "Project details"}
                </SectionTitle>
                <Text style={[styles.composerMeta, { color: colors.text.secondary }]}>
                  {activeConnection?.host.name ?? activeHost?.name ?? "Select a host to continue"}
                </Text>
              </View>
              {activeHost ? (
                <StatusBadge
                  label={activeHostOffline ? "offline" : "connected"}
                  tone={activeHostOffline ? "warning" : "success"}
                />
              ) : null}
            </View>

            <FormField
              value={newProjectPath}
              onChangeText={(value) => {
                setNewProjectPath(value);
                setComposerStep("path");
              }}
              placeholder="~/work/ace"
              autoCapitalize="none"
              autoCorrect={false}
            />

            {composerStep === "details" ? (
              <FormField
                value={newProjectTitle}
                onChangeText={setNewProjectTitle}
                placeholder="Project name (optional)"
              />
            ) : null}

            <View style={styles.composerActions}>
              <Pressable
                accessibilityRole="button"
                disabled={browsingProjectPath || activeHostOffline}
                onPress={() => void browseProjectPath()}
                style={({ pressed }) => [
                  styles.composerAction,
                  {
                    backgroundColor: colors.bg.canvas,
                    borderColor: colors.border.soft,
                    opacity: pressed ? 0.72 : 1,
                  },
                  (browsingProjectPath || activeHostOffline) && styles.disabledAction,
                ]}
              >
                {browsingProjectPath ? (
                  <ActivityIndicator size="small" color={colors.accent.primary} />
                ) : (
                  <FolderOpen size={16} color={colors.accent.primary} strokeWidth={2.1} />
                )}
                <Text style={[styles.composerActionLabel, { color: colors.text.primary }]}>
                  {browsingProjectPath ? "Browsing" : "Browse"}
                </Text>
              </Pressable>

              {composerStep === "path" ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={newProjectPath.trim().length === 0}
                  onPress={() => setComposerStep("details")}
                  style={({ pressed }) => [
                    styles.composerAction,
                    {
                      backgroundColor:
                        newProjectPath.trim().length > 0 ? colors.accent.primary : colors.bg.canvas,
                      borderColor:
                        newProjectPath.trim().length > 0
                          ? colors.accent.primary
                          : colors.border.soft,
                      opacity: pressed ? 0.72 : 1,
                    },
                    newProjectPath.trim().length === 0 && styles.disabledAction,
                  ]}
                >
                  <ChevronRight
                    size={16}
                    color={
                      newProjectPath.trim().length > 0 ? colors.text.inverse : colors.text.secondary
                    }
                    strokeWidth={2.1}
                  />
                  <Text
                    style={[
                      styles.composerActionLabel,
                      {
                        color:
                          newProjectPath.trim().length > 0
                            ? colors.text.inverse
                            : colors.text.secondary,
                      },
                    ]}
                  >
                    Continue
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={creatingProject || activeHostOffline}
                  onPress={() => void createProject()}
                  style={({ pressed }) => [
                    styles.composerAction,
                    {
                      backgroundColor: colors.accent.primary,
                      borderColor: colors.accent.primary,
                      opacity: pressed ? 0.72 : 1,
                    },
                    (creatingProject || activeHostOffline) && styles.disabledAction,
                  ]}
                >
                  {creatingProject ? (
                    <ActivityIndicator size="small" color={colors.text.inverse} />
                  ) : (
                    <Plus size={16} color={colors.text.inverse} strokeWidth={2.1} />
                  )}
                  <Text style={[styles.composerActionLabel, { color: colors.text.inverse }]}>
                    {creatingProject ? "Creating" : "Create"}
                  </Text>
                </Pressable>
              )}
            </View>

            {projectBrowseResult ? (
              <View style={[styles.browseResults, { borderTopColor: colors.border.soft }]}>
                <Text style={[styles.browseMeta, { color: colors.text.tertiary }]}>
                  {projectBrowseLoadedPath ?? projectBrowseResult.parentPath}
                </Text>
                {projectBrowseResult.entries.slice(0, 6).map((entry) => (
                  <Pressable
                    key={entry.fullPath}
                    onPress={() => {
                      setNewProjectPath(entry.fullPath);
                      setComposerStep("details");
                    }}
                    style={({ pressed }) => [
                      styles.browseRow,
                      {
                        backgroundColor: pressed
                          ? withAlpha(colors.text.primary, 0.03)
                          : "transparent",
                        borderBottomColor: colors.border.soft,
                      },
                    ]}
                  >
                    <Text style={[styles.browseRowTitle, { color: colors.text.primary }]}>
                      {entry.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.browseRowPath, { color: colors.text.secondary }]}
                    >
                      {entry.fullPath}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {composerError ? (
              <Text style={[styles.composerError, { color: colors.status.danger }]}>
                {composerError}
              </Text>
            ) : null}
          </Panel>
        ) : null}

        <View style={styles.sectionHeader}>
          <SectionTitle>Workspace Index</SectionTitle>
          <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
            {hasHosts
              ? `${filteredProjects.length} visible · ${connectedHostCount} online`
              : "No hosts"}
          </Text>
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
          <InsetGroup style={styles.projectShell}>
            {filteredProjects.map((entry, index) => (
              <Animated.View
                key={`${entry.hostId}-${entry.project.id}`}
                entering={enterRow(index)}
                exiting={exitRow}
                layout={layoutTransition}
              >
                <Pressable
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
              </Animated.View>
            ))}
          </InsetGroup>
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
  searchWrap: {
    marginTop: 14,
  },
  scopeSection: {
    gap: 10,
    marginTop: 8,
  },
  composerPanel: {
    marginTop: 14,
    gap: 14,
  },
  composerHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  composerHeaderCopy: {
    flex: 1,
    gap: 6,
  },
  composerMeta: {
    fontSize: 13,
    lineHeight: 18,
  },
  composerActions: {
    flexDirection: "row",
    gap: 10,
  },
  composerAction: {
    minHeight: 44,
    flex: 1,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  composerActionLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  disabledAction: {
    opacity: 0.5,
  },
  browseResults: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    gap: 2,
  },
  browseMeta: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  browseRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  browseRowTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  browseRowPath: {
    marginTop: 3,
    fontSize: 12,
  },
  composerError: {
    fontSize: 13,
    lineHeight: 18,
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
