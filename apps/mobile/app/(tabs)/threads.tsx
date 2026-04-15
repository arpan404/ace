import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { MessageSquare, ChevronRight } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../../src/rpc/ConnectionManager";
import type { OrchestrationThread } from "@ace/contracts";
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

export default function ProjectThreadsScreen() {
  const router = useRouter();
  const { projectId, hostId } = useLocalSearchParams<{ projectId: string; hostId: string }>();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [threads, setThreads] = useState<OrchestrationThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [hostName, setHostName] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchThreads = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const conn = connectionManager.getConnections().find((c) => c.host.id === hostId);
    if (!conn || conn.status.kind !== "connected") {
      setThreads([]);
      setHostName("");
      setLoadError("Host is unavailable. Reconnect the device and pull to refresh.");
      setLoading(false);
      return;
    }

    setHostName(conn.host.name);
    try {
      const snapshot = await conn.client.orchestration.getSnapshot({
        hydrateThreadId: undefined,
      });
      const projectThreads = snapshot.threads.filter((t) => t.projectId === projectId);
      projectThreads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setThreads(projectThreads);
    } catch (error) {
      const message = formatErrorMessage(error);
      console.error(`Failed to fetch threads for ${conn.host.name}: ${message}`);
      setThreads([]);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [hostId, projectId]);

  useEffect(() => {
    void fetchThreads();
  }, [fetchThreads]);

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 10 }]}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={fetchThreads} tintColor={theme.primary} />
        }
      >
        <ScreenHeader
          title="Threads"
          subtitle={
            hostName ? `${threads.length} in ${hostName}` : `${threads.length} in selected project`
          }
        />
        <SectionHeader title="Open thread" />
        {loadError ? <ErrorBox message={loadError} onDismiss={() => setLoadError(null)} /> : null}

        {threads.length === 0 && !loading && (
          <Card style={styles.emptyStateSimple}>
            <MessageSquare
              size={32}
              color={theme.mutedForeground}
              style={{ opacity: 0.7, marginBottom: 12 }}
            />
            <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>
              No threads for this project.
            </Text>
          </Card>
        )}

        {threads.length > 0 && (
          <List>
            {threads.map((thread) => (
              <ListItem
                key={thread.id}
                title={thread.messages.at(-1)?.text || "Untitled thread"}
                subtitle={`Updated ${new Date(thread.updatedAt).toLocaleDateString()}`}
                onPress={() => router.push({ pathname: `/chat/${thread.id}`, params: { hostId } })}
                leftElement={
                  <View style={[styles.threadDot, { backgroundColor: `${theme.primary}1a` }]}>
                    <MessageSquare size={14} color={theme.primary} />
                  </View>
                }
                rightElement={<ChevronRight size={18} color={theme.mutedForeground} />}
              />
            ))}
          </List>
        )}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 0,
    paddingBottom: 140,
  },
  emptyStateSimple: {
    marginHorizontal: 16,
    marginTop: 10,
    paddingVertical: 34,
    alignItems: "center",
  },
  emptyText: {
    textAlign: "center",
    fontSize: 14,
    fontWeight: "500",
  },
  threadDot: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});
