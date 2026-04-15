import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, RefreshControl, Text } from "react-native";
import { ChevronRight, FolderOpen } from "lucide-react-native";
import { useRouter } from "expo-router";
import { useTheme } from "../../src/design/ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import type { OrchestrationProject } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";
import {
  SafeScreen,
  ScreenHeader,
  SectionHeader,
  List,
  ListItem,
  Card,
  ErrorBox,
} from "../../src/design/Components";

export default function ProjectsScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aggregatedProjects, setAggregatedProjects] = useState<
    Array<{ project: OrchestrationProject; hostName: string; hostId: string }>
  >([]);

  useEffect(() => {
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
      refreshProjects(conns);
    });
  }, []);

  const refreshProjects = async (activeConns = connections) => {
    setRefreshing(true);
    setError(null);
    const allProjects: Array<{ project: OrchestrationProject; hostName: string; hostId: string }> =
      [];
    const failures: string[] = [];

    try {
      await Promise.all(
        activeConns.map(async (conn) => {
          if (conn.status.kind === "connected") {
            try {
              const snapshot = await conn.client.orchestration.getSnapshot();
              snapshot.projects
                .filter((p) => !p.deletedAt)
                .forEach((p) => {
                  allProjects.push({ project: p, hostName: conn.host.name, hostId: conn.host.id });
                });
            } catch (err) {
              const message = formatErrorMessage(err);
              failures.push(`${conn.host.name}: ${message}`);
              console.error(`Failed to fetch projects for ${conn.host.name}: ${message}`);
            }
          }
        }),
      );
    } finally {
      allProjects.sort((a, b) => a.project.name.localeCompare(b.project.name));
      setAggregatedProjects(allProjects);
      if (failures.length > 0) {
        setError(failures.join(", "));
      }
      setRefreshing(false);
    }
  };

  if (hosts.length === 0) {
    return (
      <SafeScreen>
        <View style={[styles.centerContainer, { paddingTop: insets.top }]}>
          <FolderOpen size={42} color={theme.primary} style={{ marginBottom: 24 }} />
          <Card style={styles.emptyCard}>
            Projects will appear here once you pair a host and create projects.
          </Card>
        </View>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + 12, paddingBottom: 140 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => refreshProjects()}
            tintColor={theme.primary}
          />
        }
      >
        <ScreenHeader title="Projects" subtitle={`${aggregatedProjects.length} total`} />

        {error ? <ErrorBox message={error} onDismiss={() => setError(null)} /> : null}

        {aggregatedProjects.length === 0 ? (
          <View style={styles.emptyState}>
            <FolderOpen size={40} color={theme.mutedForeground} style={{ marginBottom: 12 }} />
            <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>
              No projects yet
            </Text>
          </View>
        ) : (
          <>
            <SectionHeader title="All Projects" />
            <List>
              {aggregatedProjects.map(({ project, hostName, hostId }) => (
                <ListItem
                  key={`${hostId}-${project.id}`}
                  title={project.name}
                  subtitle={`on ${hostName}`}
                  onPress={() => {
                    router.push({
                      pathname: "/(tabs)/threads",
                      params: { projectId: project.id, hostId },
                    });
                  }}
                  leftElement={
                    <View style={[styles.projectIcon, { backgroundColor: `${theme.primary}1a` }]}>
                      <FolderOpen size={14} color={theme.primary} />
                    </View>
                  }
                  rightElement={<ChevronRight size={18} color={theme.mutedForeground} />}
                />
              ))}
            </List>
          </>
        )}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  emptyCard: {
    textAlign: "center",
    alignItems: "center",
  },
  scrollContent: {
    paddingHorizontal: 16,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    opacity: 0.65,
  },
  emptyText: {
    fontSize: 14,
    fontWeight: "500",
  },
  projectIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});
