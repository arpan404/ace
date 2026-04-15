import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeMode } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";

const THEME_OPTIONS: Array<{ label: string; value: ThemeMode; emoji: string }> = [
  { label: "Light", value: "light", emoji: "☀️" },
  { label: "Dark", value: "dark", emoji: "🌙" },
  { label: "System", value: "system", emoji: "🖥️" },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { colors, themeMode, setThemeMode } = useTheme();
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
          <Text style={[styles.largeTitle, { color: colors.foreground }]}>Settings</Text>
        </View>

        {/* Hosts Section */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>HOSTS</Text>
        </View>
        {hosts.length === 0 ? (
          <View
            style={[styles.groupContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
          >
            <View style={styles.emptyRow}>
              <Text style={[styles.emptyRowText, { color: colors.muted }]}>
                No hosts paired yet
              </Text>
            </View>
          </View>
        ) : (
          <View
            style={[styles.groupContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
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
                        pathname: "/settings/device/[id]",
                        params: { id: host.id },
                      })
                    }
                    style={({ pressed }) => [
                      styles.row,
                      pressed && { backgroundColor: colors.fill },
                    ]}
                  >
                    <View style={styles.rowLeft}>
                      <View
                        style={[
                          styles.statusDot,
                          {
                            backgroundColor: isConnected ? colors.green : colors.muted,
                          },
                        ]}
                      />
                      <View>
                        <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                          {host.name}
                        </Text>
                        <Text style={[styles.rowSubtitle, { color: colors.muted }]}>
                          {isConnected ? "Connected" : "Disconnected"}
                        </Text>
                      </View>
                    </View>
                    <Text style={[styles.chevron, { color: colors.separator }]}>›</Text>
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>
        )}

        <Pressable
          onPress={() => router.push("/pairing")}
          style={[
            styles.groupContainer,
            { backgroundColor: colors.secondaryGroupedBackground, marginTop: 10 },
          ]}
        >
          <View style={styles.row}>
            <Text style={[styles.actionText, { color: colors.primary }]}>+ Pair New Host</Text>
          </View>
        </Pressable>

        {/* Appearance Section */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>APPEARANCE</Text>
        </View>
        <View
          style={[styles.groupContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
        >
          {THEME_OPTIONS.map((option, i) => {
            const isActive = themeMode === option.value;
            return (
              <React.Fragment key={option.value}>
                {i > 0 && (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                )}
                <Pressable
                  onPress={() => setThemeMode(option.value)}
                  style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.fill }]}
                >
                  <View style={styles.rowLeft}>
                    <Text style={styles.themeEmoji}>{option.emoji}</Text>
                    <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                      {option.label}
                    </Text>
                  </View>
                  {isActive && <Text style={[styles.checkmark, { color: colors.primary }]}>✓</Text>}
                </Pressable>
              </React.Fragment>
            );
          })}
        </View>

        {/* About Section */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>ABOUT</Text>
        </View>
        <View
          style={[styles.groupContainer, { backgroundColor: colors.secondaryGroupedBackground }]}
        >
          <View style={styles.aboutRow}>
            <Text style={[styles.aboutLabel, { color: colors.foreground }]}>Version</Text>
            <Text style={[styles.aboutValue, { color: colors.muted }]}>0.0.1</Text>
          </View>
          <View style={[styles.separator, { backgroundColor: colors.separator }]} />
          <View style={styles.aboutRow}>
            <Text style={[styles.aboutLabel, { color: colors.foreground }]}>ace Mobile</Text>
            <Text style={[styles.aboutValue, { color: colors.muted }]}>
              Agent control everywhere
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  largeTitle: { fontSize: 34, fontWeight: "700", letterSpacing: 0.37 },
  sectionHeader: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  groupContainer: {
    marginHorizontal: 20,
    borderRadius: 12,
    overflow: "hidden",
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 13,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  rowTitle: { fontSize: 17 },
  rowSubtitle: { fontSize: 14, marginTop: 1 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  chevron: { fontSize: 22, fontWeight: "300" },
  checkmark: { fontSize: 17, fontWeight: "600" },
  actionText: { fontSize: 17, fontWeight: "500" },
  themeEmoji: { fontSize: 20 },
  emptyRow: { paddingVertical: 16, paddingHorizontal: 16, alignItems: "center" },
  emptyRowText: { fontSize: 15 },
  aboutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  aboutLabel: { fontSize: 17 },
  aboutValue: { fontSize: 15 },
});
