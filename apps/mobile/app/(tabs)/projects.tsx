import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
    <View style={[styles.root, { backgroundColor: colors.groupedBackground }]}>
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
          <View style={[styles.emptyCard, { backgroundColor: colors.secondaryGroupedBackground }]}>
            <Text style={styles.emptyEmoji}>📁</Text>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No projects yet</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              Projects will appear here once you create them from the desktop app.
            </Text>
          </View>
        ) : (
          <View
            style={[styles.listContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
          >
            {aggregatedProjects.map(({ project, hostName, hostId }, i) => (
              <React.Fragment key={`${hostId}-${project.id}`}>
                {i > 0 && (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                )}
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/host/[hostId]",
                      params: { hostId, projectId: project.id },
                    })
                  }
                  style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.fill }]}
                >
                  <View style={[styles.projectIcon, { backgroundColor: `${colors.primary}18` }]}>
                    <Text style={styles.projectEmoji}>📂</Text>
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
                  <Text style={[styles.chevron, { color: colors.separator }]}>›</Text>
                </Pressable>
              </React.Fragment>
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
  emptyCard: {
    marginHorizontal: 20,
    marginTop: 20,
    borderRadius: 12,
    padding: 32,
    alignItems: "center",
  },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 20, fontWeight: "600", marginBottom: 6 },
  emptySubtitle: { fontSize: 15, textAlign: "center", lineHeight: 22 },
  listContainer: {
    marginHorizontal: 20,
    marginTop: 20,
    borderRadius: 12,
    overflow: "hidden",
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 60 },
  row: {
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
  projectHost: { fontSize: 14, marginTop: 2 },
  chevron: { fontSize: 22, fontWeight: "300" },
});
