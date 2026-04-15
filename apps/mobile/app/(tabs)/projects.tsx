import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  ScrollView,
  StyleSheet,
  RefreshControl,
  Text,
  Pressable,
  TextInput,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FolderOpen, ChevronRight, Plus } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { useUIStateStore } from "../../src/store/UIStateStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { DEFAULT_MODEL_BY_PROVIDER, type OrchestrationProject } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";
import { newCommandId, newProjectId } from "@ace/shared/ids";

export default function ProjectsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const activeHostId = useUIStateStore((s) => s.activeHostId);
  const setActiveHostId = useUIStateStore((s) => s.setActiveHostId);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [aggregatedProjects, setAggregatedProjects] = useState<
    Array<{ project: OrchestrationProject; hostName: string; hostId: string }>
  >([]);

  useEffect(() => {
    const hasActiveHost = activeHostId ? hosts.some((host) => host.id === activeHostId) : false;
    if (!hasActiveHost && hosts.length > 0 && hosts[0]) {
      setActiveHostId(hosts[0].id);
    }
  }, [activeHostId, hosts, setActiveHostId]);

  const activeConnection = useMemo(() => {
    if (activeHostId) {
      const matching = connections.find((connection) => connection.host.id === activeHostId);
      if (matching) {
        return matching;
      }
    }
    return connections[0] ?? null;
  }, [activeHostId, connections]);

  const refreshProjects = useCallback(
    async (activeConns = connections) => {
      setRefreshing(true);
      setError(null);
      const allProjects: Array<{
        project: OrchestrationProject;
        hostName: string;
        hostId: string;
      }> = [];

      try {
        await Promise.all(
          activeConns.map(async (conn) => {
            try {
              const snapshot = await conn.client.orchestration.getSnapshot();
              snapshot.projects
                .filter((p) => !p.deletedAt)
                .forEach((p) => {
                  allProjects.push({
                    project: p,
                    hostName: conn.host.name,
                    hostId: conn.host.id,
                  });
                });
            } catch (err) {
              console.error(
                `Failed to fetch projects for ${conn.host.name}: ${formatErrorMessage(err)}`,
              );
            }
          }),
        );
      } finally {
        allProjects.sort((a, b) => a.project.name.localeCompare(b.project.name));
        setAggregatedProjects(allProjects);
        setRefreshing(false);
      }
    },
    [connections],
  );

  useEffect(() => {
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
      void refreshProjects(conns);
    });
  }, [refreshProjects]);

  const createProject = useCallback(async () => {
    const targetConnection = activeConnection;
    if (!targetConnection) {
      setError("No host connection is available.");
      return;
    }
    const workspaceRoot = newProjectPath.trim();
    if (workspaceRoot.length === 0) {
      setError("Workspace path is required.");
      return;
    }
    const derivedTitle =
      workspaceRoot.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? workspaceRoot;
    const title = newProjectTitle.trim() || derivedTitle;

    setCreatingProject(true);
    setError(null);
    try {
      await targetConnection.client.orchestration.dispatchCommand({
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
      setIsCreatingProject(false);
      await refreshProjects();
    } catch (err) {
      setError(`Could not create project: ${formatErrorMessage(err)}`);
    } finally {
      setCreatingProject(false);
    }
  }, [activeConnection, newProjectPath, newProjectTitle, refreshProjects]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 100,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshProjects()}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.header}>
          <Text style={[styles.largeTitle, { color: colors.foreground }]}>Projects</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {aggregatedProjects.length} across all hosts
          </Text>
          <Pressable
            onPress={() => setIsCreatingProject((current) => !current)}
            style={[styles.createButton, { backgroundColor: colors.secondaryGroupedBackground }]}
          >
            <Plus size={16} color={colors.primary} strokeWidth={2.5} />
            <Text style={[styles.createButtonText, { color: colors.foreground }]}>
              {isCreatingProject ? "Cancel" : "New Project"}
            </Text>
          </Pressable>
        </View>
        {isCreatingProject ? (
          <View style={styles.createCard}>
            <TextInput
              value={newProjectPath}
              onChangeText={setNewProjectPath}
              placeholder="/absolute/path/to/project"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  borderColor: colors.separator,
                  backgroundColor: colors.background,
                },
              ]}
            />
            <TextInput
              value={newProjectTitle}
              onChangeText={setNewProjectTitle}
              placeholder="Project name (optional)"
              placeholderTextColor={colors.muted}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  borderColor: colors.separator,
                  backgroundColor: colors.background,
                },
              ]}
            />
            {error ? <Text style={[styles.errorText, { color: colors.red }]}>{error}</Text> : null}
            <Pressable
              onPress={() => void createProject()}
              disabled={creatingProject}
              style={[
                styles.createSubmitButton,
                { backgroundColor: colors.primary },
                creatingProject && { opacity: 0.6 },
              ]}
            >
              <Text style={[styles.createSubmitButtonText, { color: colors.primaryForeground }]}>
                {creatingProject ? "Creating…" : "Create Project"}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {error && !isCreatingProject ? (
          <Text style={[styles.errorBanner, { color: colors.red }]}>{error}</Text>
        ) : null}

        {aggregatedProjects.length === 0 && !refreshing ? (
          <View style={styles.emptyContent}>
            <View style={[styles.emptyIcon, { backgroundColor: `${colors.orange}14` }]}>
              <FolderOpen size={32} color={colors.orange} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No projects yet</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              Projects will appear here once you create them from the desktop app.
            </Text>
          </View>
        ) : (
          <View style={styles.projectList}>
            {aggregatedProjects.map(({ project, hostName, hostId }, i) => (
              <Pressable
                key={`${hostId}-${project.id}`}
                onPress={() =>
                  router.push({
                    pathname: "/host/[hostId]",
                    params: { hostId, projectId: project.id },
                  })
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              >
                <View style={[styles.projectIcon, { backgroundColor: `${colors.primary}14` }]}>
                  <FolderOpen size={18} color={colors.primary} />
                </View>
                <View style={styles.rowContent}>
                  <Text
                    style={[styles.projectName, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {project.name}
                  </Text>
                  <Text style={[styles.projectHost, { color: colors.muted }]}>{hostName}</Text>
                </View>
                <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                {i < aggregatedProjects.length - 1 && (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                )}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  largeTitle: { fontSize: 34, fontWeight: "700", letterSpacing: 0.37 },
  subtitle: { fontSize: 15, marginTop: 2 },
  createButton: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  createButtonText: { fontSize: 14, fontWeight: "600" },
  createCard: {
    marginHorizontal: 20,
    marginTop: 12,
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  createSubmitButton: {
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  createSubmitButtonText: {
    fontSize: 14,
    fontWeight: "700",
  },
  errorText: { fontSize: 13 },
  errorBanner: {
    marginHorizontal: 20,
    marginTop: 10,
    fontSize: 13,
  },
  emptyContent: { alignItems: "center", paddingHorizontal: 40, paddingTop: 80 },
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
  },
  projectList: { paddingHorizontal: 20, paddingTop: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 12,
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 50,
    right: 0,
    height: StyleSheet.hairlineWidth,
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
  projectHost: { fontSize: 13, marginTop: 2 },
});
