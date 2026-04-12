import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { Folder, ChevronRight, Server, Plus, FolderOpen } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import type { OrchestrationProject } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";
import {
  GlassGroup,
  GlassIconOrb,
  GlassRow,
  GlassActionButton,
  LiquidScreen,
  PageHeader,
  RowSeparator,
  SectionLabel,
} from "../../src/design/LiquidGlass";

export default function ProjectsScreen() {
  const router = useRouter();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [aggregatedProjects, setAggregatedProjects] = useState<
    Array<{ project: OrchestrationProject; hostName: string; hostId: string }>
  >([]);
  const connectedHostCount = connections.filter((conn) => conn.status.kind === "connected").length;

  useEffect(() => {
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
      refreshProjects(conns);
    });
  }, []);

  const refreshProjects = async (activeConns = connections) => {
    setRefreshing(true);
    setRefreshError(null);
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
            } catch (error) {
              const message = formatErrorMessage(error);
              failures.push(`${conn.host.name}: ${message}`);
              console.error(`Failed to fetch projects for ${conn.host.name}: ${message}`);
            }
          }
        }),
      );
    } finally {
      allProjects.sort((a, b) => a.project.name.localeCompare(b.project.name));
      setAggregatedProjects(allProjects);
      setRefreshError(failures.length > 0 ? failures.join("\n") : null);
      setRefreshing(false);
    }
  };

  if (hosts.length === 0) {
    return (
      <LiquidScreen style={styles.centerContainer}>
        <View
          style={[
            styles.emptyIconBg,
            { backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)" },
          ]}
        >
          <Server size={42} color={theme.primary} />
        </View>
        <Text style={[styles.emptyTitle, { color: theme.foreground }]}>No Hosts Connected</Text>
        <Text style={[styles.emptySubtitle, { color: theme.mutedForeground }]}>
          Pair your device with a desktop host to view and manage projects.
        </Text>
        <GlassActionButton onPress={() => router.push("/pairing")}>
          <View style={styles.addButtonContent}>
            <Plus size={18} color={theme.primaryForeground} />
            <Text style={[styles.addButtonText, { color: theme.primaryForeground }]}>
              Pair New Device
            </Text>
          </View>
        </GlassActionButton>
      </LiquidScreen>
    );
  }

  return (
    <LiquidScreen>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 20 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => refreshProjects()}
            tintColor={theme.primary}
          />
        }
      >
        <PageHeader
          title="Projects"
          subtitle={`${aggregatedProjects.length} available across ${connectedHostCount} connected ${
            connectedHostCount === 1 ? "host" : "hosts"
          }`}
        />
        <SectionLabel>Open Project</SectionLabel>
        {refreshError ? (
          <Text style={[styles.errorText, { color: theme.destructive }]}>{refreshError}</Text>
        ) : null}

        {aggregatedProjects.length === 0 && !refreshing && (
          <View style={styles.emptyStateSimple}>
            <FolderOpen
              size={32}
              color={theme.mutedForeground}
              style={{ opacity: 0.5, marginBottom: 16 }}
            />
            <Text
              style={{
                color: theme.mutedForeground,
                textAlign: "center",
                fontSize: 15,
                fontWeight: "500",
              }}
            >
              No projects found.
            </Text>
          </View>
        )}

        {aggregatedProjects.length > 0 && (
          <GlassGroup>
            {aggregatedProjects.map(({ project, hostName, hostId }, index) => (
              <React.Fragment key={`${hostId}-${project.id}`}>
                <GlassRow
                  onPress={() =>
                    router.push({
                      pathname: "/(tabs)/threads",
                      params: { projectId: project.id, hostId },
                    })
                  }
                  style={styles.projectRow}
                >
                  <View style={styles.projectInfo}>
                    <GlassIconOrb>
                      <Folder size={16} color={theme.primary} />
                    </GlassIconOrb>
                    <View style={styles.textContainer}>
                      <Text
                        style={[styles.projectName, { color: theme.foreground }]}
                        numberOfLines={1}
                      >
                        {project.name}
                      </Text>
                      <Text style={[styles.projectHost, { color: theme.mutedForeground }]}>
                        {hostName}
                      </Text>
                    </View>
                  </View>
                  <ChevronRight size={20} color={theme.mutedForeground} />
                </GlassRow>
                {index < aggregatedProjects.length - 1 ? <RowSeparator inset={64} /> : null}
              </React.Fragment>
            ))}
          </GlassGroup>
        )}
      </ScrollView>
    </LiquidScreen>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyIconBg: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginBottom: 12,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 16,
    textAlign: "center",
    lineHeight: 24,
    marginBottom: 40,
  },
  addButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 8,
  },
  addButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  emptyStateSimple: {
    paddingTop: 60,
    paddingBottom: 40,
    alignItems: "center",
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 140,
  },
  projectRow: {
    paddingVertical: 12,
  },
  projectInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    flex: 1,
  },
  textContainer: {
    flex: 1,
    marginRight: 10,
  },
  projectName: {
    fontSize: 16,
    fontWeight: "500",
  },
  projectHost: {
    fontSize: 13,
    marginTop: 2,
  },
  errorText: {
    marginBottom: 10,
    marginLeft: 16,
    fontSize: 13,
    lineHeight: 18,
  },
});
