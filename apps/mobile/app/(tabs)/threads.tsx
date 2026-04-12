import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { useRouter, useLocalSearchParams, Stack } from "expo-router";
import { MessageSquare, ChevronRight } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { connectionManager } from "../../src/rpc/ConnectionManager";
import type { OrchestrationThread } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";
import {
  GlassGroup,
  GlassIconOrb,
  GlassRow,
  LiquidScreen,
  PageHeader,
  RowSeparator,
  SectionLabel,
} from "../../src/design/LiquidGlass";

export default function ProjectThreadsScreen() {
  const router = useRouter();
  const { projectId, hostId } = useLocalSearchParams<{ projectId: string; hostId: string }>();
  const { theme } = useTheme();
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
    <LiquidScreen>
      <Stack.Screen
        options={{
          title: "",
          headerBackTitleVisible: false,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.primary,
        }}
      />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={fetchThreads} tintColor={theme.primary} />
        }
      >
        <PageHeader
          title="Threads"
          subtitle={
            hostName ? `${threads.length} in ${hostName}` : `${threads.length} in selected project`
          }
        />
        <SectionLabel>Open Thread</SectionLabel>
        {loadError ? (
          <Text style={[styles.errorText, { color: theme.destructive }]}>{loadError}</Text>
        ) : null}

        {threads.length === 0 && !loading && (
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
              No threads for this project.
            </Text>
          </View>
        )}

        {threads.length > 0 && (
          <GlassGroup>
            {threads.map((thread, index) => (
              <React.Fragment key={thread.id}>
                <GlassRow
                  onPress={() =>
                    router.push({ pathname: `/chat/${thread.id}`, params: { hostId } })
                  }
                  style={styles.threadRow}
                >
                  <View style={styles.threadInfo}>
                    <GlassIconOrb>
                      <MessageSquare size={16} color={theme.primary} />
                    </GlassIconOrb>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text
                        style={[styles.threadTitle, { color: theme.foreground }]}
                        numberOfLines={1}
                      >
                        {thread.messages.at(-1)?.text || "Untitled Thread"}
                      </Text>
                      <Text style={[styles.threadDate, { color: theme.mutedForeground }]}>
                        Updated {new Date(thread.updatedAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <ChevronRight size={20} color={theme.mutedForeground} />
                  </View>
                </GlassRow>
                {index < threads.length - 1 ? <RowSeparator inset={64} /> : null}
              </React.Fragment>
            ))}
          </GlassGroup>
        )}
      </ScrollView>
    </LiquidScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 140,
  },
  emptyStateSimple: {
    paddingTop: 60,
    paddingBottom: 40,
    alignItems: "center",
  },
  threadRow: {
    paddingVertical: 12,
  },
  threadInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  threadTitle: {
    fontSize: 16,
    fontWeight: "500",
  },
  threadDate: {
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
