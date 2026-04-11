import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { Plus, Activity, ChevronRight, MessageSquare, Server } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import type { OrchestrationThread } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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

export default function HomeScreen() {
  const router = useRouter();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [aggregatedThreads, setAggregatedThreads] = useState<
    Array<{ thread: OrchestrationThread; hostName: string; hostId: string }>
  >([]);
  const connectedHostCount = connections.filter((conn) => conn.status.kind === "connected").length;
  const visibleThreads = aggregatedThreads.slice(0, 30);

  useEffect(() => {
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
      refreshThreads(conns);
    });
  }, []);

  const refreshThreads = async (activeConns = connections) => {
    setRefreshing(true);
    setRefreshError(null);
    const allThreads: Array<{ thread: OrchestrationThread; hostName: string; hostId: string }> = [];
    const failures: string[] = [];

    try {
      await Promise.all(
        activeConns.map(async (conn) => {
          if (conn.status.kind === "connected") {
            try {
              const snapshot = await conn.client.orchestration.getSnapshot();
              snapshot.threads.forEach((t) => {
                allThreads.push({ thread: t, hostName: conn.host.name, hostId: conn.host.id });
              });
            } catch (error) {
              const message = formatErrorMessage(error);
              failures.push(`${conn.host.name}: ${message}`);
              console.error(`Failed to fetch threads for ${conn.host.name}: ${message}`);
            }
          }
        }),
      );
    } finally {
      allThreads.sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
      setAggregatedThreads(allThreads);
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
          Pair your device with a desktop host to view live activity and chat with your agents.
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
            onRefresh={() => refreshThreads()}
            tintColor={theme.primary}
          />
        }
      >
        <PageHeader
          title="Activity"
          subtitle={`${connectedHostCount} connected ${connectedHostCount === 1 ? "host" : "hosts"}`}
        />
        <SectionLabel>Recent Threads</SectionLabel>
        {refreshError ? (
          <Text style={[styles.errorText, { color: theme.destructive }]}>{refreshError}</Text>
        ) : null}

        {visibleThreads.length === 0 && !refreshing && (
          <View style={styles.emptyStateSimple}>
            <MessageSquare
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
              No recent activity found.
            </Text>
          </View>
        )}

        {visibleThreads.length > 0 && (
          <GlassGroup>
            {visibleThreads.map(({ thread, hostName, hostId }, index) => (
              <React.Fragment key={`${hostId}-${thread.id}`}>
                <GlassRow
                  onPress={() =>
                    router.push({ pathname: `/chat/${thread.id}`, params: { hostId } })
                  }
                  style={styles.threadRow}
                >
                  <View style={styles.threadHeader}>
                    <View style={styles.threadLeft}>
                      <GlassIconOrb>
                        <MessageSquare size={16} color={theme.primary} />
                      </GlassIconOrb>
                      <View style={styles.rowText}>
                        <Text
                          style={[styles.threadTitle, { color: theme.foreground }]}
                          numberOfLines={1}
                        >
                          {thread.messages.at(-1)?.text || "New Thread"}
                        </Text>
                        <Text
                          style={[styles.threadSummary, { color: theme.mutedForeground }]}
                          numberOfLines={1}
                        >
                          {hostName}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.threadRight}>
                      <Text style={[styles.timeText, { color: theme.mutedForeground }]}>
                        {new Date(thread.updatedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Text>
                      <ChevronRight size={18} color={theme.mutedForeground} />
                    </View>
                  </View>
                </GlassRow>
                {index < visibleThreads.length - 1 ? <RowSeparator inset={64} /> : null}
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
  threadRow: {
    paddingVertical: 12,
  },
  threadHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  threadLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 14,
  },
  rowText: {
    flex: 1,
    paddingRight: 8,
  },
  threadRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: 8,
  },
  timeText: {
    fontSize: 13,
    fontWeight: "500",
  },
  threadTitle: {
    fontSize: 16,
    fontWeight: "500",
    marginBottom: 2,
  },
  threadSummary: {
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    marginBottom: 10,
    marginLeft: 16,
    fontSize: 13,
    lineHeight: 18,
  },
});
