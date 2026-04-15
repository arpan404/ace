import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";

export default function HostsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { hosts } = useHostStore();
  const [connections, setConnections] = useState<ManagedConnection[]>([]);

  useEffect(() => {
    setConnections(connectionManager.getConnections());
    return connectionManager.onStatusChange(setConnections);
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: colors.groupedBackground }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 100,
        }}
      >
        <View style={styles.header}>
          <Text style={[styles.largeTitle, { color: colors.foreground }]}>Hosts</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {hosts.length} device{hosts.length !== 1 ? "s" : ""} paired
          </Text>
        </View>

        {hosts.length === 0 ? (
          <View style={styles.emptyWrap}>
            <View
              style={[styles.emptyCard, { backgroundColor: colors.secondaryGroupedBackground }]}
            >
              <Text style={[styles.emptyIcon]}>🖥️</Text>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No hosts paired</Text>
              <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
                Scan the QR code from your ace Desktop app to connect.
              </Text>
            </View>
          </View>
        ) : (
          <View
            style={[styles.listContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
          >
            {hosts.map((host, i) => {
              const conn = connections.find((c) => c.host.id === host.id);
              const isConnected = conn?.status.kind === "connected";
              return (
                <React.Fragment key={host.id}>
                  {i > 0 && (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  )}
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: "/host/[hostId]",
                        params: { hostId: host.id },
                      })
                    }
                    style={({ pressed }) => [
                      styles.hostRow,
                      pressed && { backgroundColor: colors.fill },
                    ]}
                  >
                    <View
                      style={[
                        styles.hostIcon,
                        {
                          backgroundColor: isConnected ? `${colors.green}20` : `${colors.muted}20`,
                        },
                      ]}
                    >
                      <Text style={styles.hostIconText}>{isConnected ? "🟢" : "⚪"}</Text>
                    </View>
                    <View style={styles.hostContent}>
                      <Text
                        style={[styles.hostName, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {host.name}
                      </Text>
                      <Text style={[styles.hostStatus, { color: colors.muted }]}>
                        {isConnected ? "Connected" : "Disconnected"}
                      </Text>
                    </View>
                    <Text style={[styles.chevron, { color: colors.separator }]}>›</Text>
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>
        )}

        {/* Add Host Button */}
        <Pressable
          onPress={() => router.push("/pairing")}
          style={[styles.addButton, { backgroundColor: colors.secondaryGroupedBackground }]}
        >
          <Text style={[styles.addButtonText, { color: colors.primary }]}>+ Pair New Host</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  largeTitle: { fontSize: 34, fontWeight: "700", letterSpacing: 0.37 },
  subtitle: { fontSize: 15, marginTop: 2 },
  emptyWrap: { paddingHorizontal: 20, paddingTop: 20 },
  emptyCard: {
    borderRadius: 12,
    padding: 32,
    alignItems: "center",
  },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 20, fontWeight: "600", marginBottom: 6 },
  emptySubtitle: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
  listContainer: {
    marginHorizontal: 20,
    marginTop: 20,
    borderRadius: 12,
    overflow: "hidden",
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 60 },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  hostIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  hostIconText: { fontSize: 16 },
  hostContent: { flex: 1 },
  hostName: { fontSize: 17, fontWeight: "500" },
  hostStatus: { fontSize: 14, marginTop: 2 },
  chevron: { fontSize: 22, fontWeight: "300" },
  addButton: {
    marginHorizontal: 20,
    marginTop: 16,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  addButtonText: { fontSize: 17, fontWeight: "600" },
});
