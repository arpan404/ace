import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FolderOpen, ChevronRight } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import type { OrchestrationProject } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";

export default function ProjectsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const _hosts = useHostStore((s) => s.hosts);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [_error, setError] = useState<string | null>(null);
  const [aggregatedProjects, setAggregatedProjects] = useState<
    Array<{ project: OrchestrationProject; hostName: string; hostId: string }>
  >([]);

  useEffect(() => {
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
      void refreshProjects(conns);
    });
  }, []);

  const refreshProjects = async (activeConns = connections) => {
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
          if (conn.status.kind === "connected") {
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
          }
        }),
      );
    } finally {
      allProjects.sort((a, b) => a.project.name.localeCompare(b.project.name));
      setAggregatedProjects(allProjects);
      setRefreshing(false);
    }
  };

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
        </View>

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
