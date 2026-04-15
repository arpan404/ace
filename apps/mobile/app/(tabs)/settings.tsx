import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Sun, Moon, Monitor, Plus, ChevronRight, Check, Info } from "lucide-react-native";
import { useTheme, type ThemeMode } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import type { LucideIcon } from "lucide-react-native";

const THEME_OPTIONS: Array<{ label: string; value: ThemeMode; Icon: LucideIcon }> = [
  { label: "Light", value: "light", Icon: Sun },
  { label: "Dark", value: "dark", Icon: Moon },
  { label: "System", value: "system", Icon: Monitor },
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
    <View style={[styles.root, { backgroundColor: colors.background }]}>
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
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>HOSTS</Text>
        {hosts.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={[styles.emptyRowText, { color: colors.muted }]}>No hosts paired yet</Text>
          </View>
        ) : (
          hosts.map((host, i) => {
            const conn = connections.find((c) => c.host.id === host.id);
            const isConnected = conn?.status.kind === "connected";
            return (
              <Pressable
                key={host.id}
                onPress={() =>
                  router.push({
                    pathname: "/settings/device/[id]",
                    params: { id: host.id },
                  })
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              >
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: isConnected ? colors.green : colors.muted },
                  ]}
                />
                <View style={styles.rowContent}>
                  <Text style={[styles.rowTitle, { color: colors.foreground }]}>{host.name}</Text>
                  <Text style={[styles.rowSubtitle, { color: colors.muted }]}>
                    {isConnected ? "Connected" : "Disconnected"}
                  </Text>
                </View>
                <ChevronRight size={16} color={colors.muted} strokeWidth={2} />
                {i < hosts.length - 1 && (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                )}
              </Pressable>
            );
          })
        )}

        <Pressable
          onPress={() => router.push("/pairing")}
          style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.6 }]}
        >
          <Plus size={18} color={colors.primary} strokeWidth={2} />
          <Text style={[styles.addRowText, { color: colors.primary }]}>Pair New Host</Text>
        </Pressable>

        {/* Appearance Section */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 32 }]}>
          APPEARANCE
        </Text>
        {THEME_OPTIONS.map((option, i) => {
          const isActive = themeMode === option.value;
          const OptionIcon = option.Icon;
          return (
            <Pressable
              key={option.value}
              onPress={() => setThemeMode(option.value)}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
              <OptionIcon size={20} color={colors.foreground} strokeWidth={1.8} />
              <View style={styles.rowContent}>
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>{option.label}</Text>
              </View>
              {isActive && <Check size={18} color={colors.primary} strokeWidth={2.5} />}
              {i < THEME_OPTIONS.length - 1 && (
                <View style={[styles.separator, { backgroundColor: colors.separator }]} />
              )}
            </Pressable>
          );
        })}

        {/* About Section */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 32 }]}>ABOUT</Text>
        <View style={styles.aboutRow}>
          <Info size={18} color={colors.muted} strokeWidth={1.8} />
          <View style={styles.rowContent}>
            <Text style={[styles.aboutLabel, { color: colors.foreground }]}>ace Mobile</Text>
            <Text style={[styles.aboutValue, { color: colors.muted }]}>v0.0.1</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  largeTitle: { fontSize: 34, fontWeight: "700", letterSpacing: 0.37 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    marginTop: 24,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: 20,
    gap: 12,
    minHeight: 44,
  },
  rowContent: { flex: 1 },
  rowTitle: { fontSize: 17 },
  rowSubtitle: { fontSize: 13, marginTop: 1 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 44,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: 20,
    gap: 12,
  },
  addRowText: { fontSize: 17, fontWeight: "600" },
  emptyRow: { paddingVertical: 20, paddingHorizontal: 20, alignItems: "center" },
  emptyRowText: { fontSize: 15 },
  aboutRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: 20,
    gap: 12,
    minHeight: 44,
  },
  aboutLabel: { fontSize: 17 },
  aboutValue: { fontSize: 13, marginTop: 1 },
});
