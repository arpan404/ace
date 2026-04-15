import React, { useEffect, useState, useCallback } from "react";
import { View, ScrollView, RefreshControl, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Plus } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { useUIStateStore } from "../../src/store/UIStateStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import type { OrchestrationThread } from "@ace/contracts";
import { formatErrorMessage } from "../../src/errors";
import {
  SafeScreen,
  ScreenHeader,
  SectionHeader,
  List,
  ListItem,
  Button,
  StatusBadge,
  ErrorBox,
} from "../../src/design/Components";

export default function ThreadsListScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((s) => s.hosts);
  const activeHostId = useUIStateStore((s) => s.activeHostId);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<Array<OrchestrationThread>>([]);
  const [_searchText, setSearchText] = useState("");

  const activeConnection = connections.find((c) => c.host.id === activeHostId);
  const filteredThreads = threads.filter(
    (t) =>
      t.messages.some((m) => m.text.toLowerCase().includes(_searchText.toLowerCase())) ||
      _searchText === "",
  );

  const refreshThreads = useCallback(async () => {
    if (!activeConnection || activeConnection.status.kind !== "connected") {
      setError("No active connection");
      return;
    }

    setRefreshing(true);
    setError(null);

    try {
      const snapshot = await activeConnection.client.orchestration.getSnapshot();
      setThreads(snapshot.threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } catch (err) {
      const msg = formatErrorMessage(err);
      setError(msg);
      console.error("Failed to fetch threads:", msg);
    } finally {
      setRefreshing(false);
    }
  }, [activeConnection]);

  useEffect(() => {
    const unsubscribe = connectionManager.onStatusChange(setConnections);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (activeConnection?.status.kind === "connected") {
      void refreshThreads();
    }
  }, [activeConnection?.host.id, activeConnection?.status.kind, refreshThreads]);

  const activeHost = hosts.find((h) => h.id === activeHostId);
  const connectionStatus =
    activeConnection?.status.kind === "connected"
      ? "connected"
      : activeConnection?.status.kind === "connecting"
        ? "connecting"
        : "disconnected";

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
        scrollEnabled={true}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshThreads}
            tintColor={theme.primary}
          />
        }
      >
        <ScreenHeader
          title="Threads"
          subtitle={activeHost ? `on ${activeHost.name}` : "No host selected"}
          rightElement={
            <Button
              title="New"
              onPress={() => {
                if (activeConnection?.status.kind === "connected") {
                  router.push({ pathname: "/chat", params: { hostId: activeHostId } });
                }
              }}
              variant="primary"
              style={styles.newButton}
            />
          }
        />

        {error ? <ErrorBox message={error} onDismiss={() => setError(null)} /> : null}

        {connectionStatus !== "connected" ? (
          <View style={styles.statusCard}>
            <StatusBadge status={connectionStatus} label={activeHost?.name || "Not Connected"} />
          </View>
        ) : null}

        {filteredThreads.length === 0 ? (
          <View style={styles.emptyState}>
            <Plus size={40} color={theme.mutedForeground} />
          </View>
        ) : (
          <>
            <SectionHeader title={`Threads (${filteredThreads.length})`} />
            <List>
              {filteredThreads.map((thread) => (
                <ListItem
                  key={thread.id}
                  title={thread.messages.at(-1)?.text || "New Thread"}
                  subtitle={`${thread.messages.length} messages`}
                  onPress={() => router.push({ pathname: `/chat/${thread.id}` })}
                  highlighted={false}
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
  content: {
    paddingBottom: 140,
  },
  newButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusCard: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginVertical: 8,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    opacity: 0.5,
  },
});
