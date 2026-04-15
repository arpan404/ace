import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Server, Plus, ChevronRight } from "lucide-react-native";
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

  const connectedCount = connections.filter((c) => c.status.kind === "connected").length;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 100,
        }}
      >
        <View style={styles.header}>
          <Text style={[styles.largeTitle, { color: colors.foreground }]}>Hosts</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {hosts.length} paired · {connectedCount} online
          </Text>
        </View>

        {hosts.length === 0 ? (
          <View style={styles.emptyContent}>
            <View style={[styles.emptyIcon, { backgroundColor: `${colors.primary}14` }]}>
              <Server size={32} color={colors.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No hosts paired</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              Scan the QR code from your ace Desktop app to connect.
            </Text>
            <Pressable
              onPress={() => router.push("/pairing")}
              style={[styles.emptyButton, { backgroundColor: colors.primary }]}
            >
              <Plus size={18} color="#fff" strokeWidth={2.5} />
              <Text style={styles.emptyButtonText}>Pair Host</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.hostList}>
            {hosts.map((host, i) => {
              const conn = connections.find((c) => c.host.id === host.id);
              const isConnected = conn?.status.kind === "connected";
              return (
                <Pressable
                  key={host.id}
                  onPress={() =>
                    router.push({
                      pathname: "/host/[hostId]",
                      params: { hostId: host.id },
                    })
                  }
                  style={({ pressed }) => [styles.hostRow, pressed && { opacity: 0.6 }]}
                >
                  <View
                    style={[
                      styles.hostIconWrap,
                      {
                        backgroundColor: isConnected ? `${colors.green}14` : `${colors.muted}14`,
                      },
                    ]}
                  >
                    <Server size={18} color={isConnected ? colors.green : colors.muted} />
                  </View>
                  <View style={styles.hostContent}>
                    <Text style={[styles.hostName, { color: colors.foreground }]} numberOfLines={1}>
                      {host.name}
                    </Text>
                    <Text
                      style={[
                        styles.hostStatus,
                        { color: isConnected ? colors.green : colors.muted },
                      ]}
                    >
                      {isConnected ? "Connected" : "Offline"}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                  {i < hosts.length - 1 && (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  )}
                </Pressable>
              );
            })}

            {/* Add Host Row */}
            <Pressable
              onPress={() => router.push("/pairing")}
              style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.6 }]}
            >
              <Plus size={18} color={colors.primary} strokeWidth={2} />
              <Text style={[styles.addRowText, { color: colors.primary }]}>Pair New Host</Text>
            </Pressable>
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
    marginBottom: 28,
  },
  emptyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 25,
  },
  emptyButtonText: { fontSize: 17, fontWeight: "600", color: "#fff" },
  hostList: { paddingHorizontal: 20, paddingTop: 20 },
  hostRow: {
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
  hostIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  hostContent: { flex: 1 },
  hostName: { fontSize: 17, fontWeight: "500" },
  hostStatus: { fontSize: 13, marginTop: 2, fontWeight: "500" },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 12,
    marginTop: 8,
  },
  addRowText: { fontSize: 17, fontWeight: "600" },
});
