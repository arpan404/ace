import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, Moon, Monitor, Plus, SlidersHorizontal, Sun } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useTheme, type ThemeMode } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import {
  IconButton,
  Panel,
  RowLink,
  ScreenBackdrop,
  ScreenHeader,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { useHostStore } from "../../src/store/HostStore";
import { useAggregatedOrchestration } from "../../src/orchestration/mobileData";

const THEME_OPTIONS: Array<{ label: string; value: ThemeMode; Icon: LucideIcon }> = [
  { label: "Light", value: "light", Icon: Sun },
  { label: "Dark", value: "dark", Icon: Moon },
  { label: "System", value: "system", Icon: Monitor },
];

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, themeMode, setThemeMode } = useTheme();
  const hosts = useHostStore((state) => state.hosts);
  const { connections } = useAggregatedOrchestration();
  const connectedHostCount = connections.filter(
    (connection) => connection.status.kind === "connected",
  ).length;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
      >
        <ScreenHeader
          eyebrow="ace"
          title="Settings"
          subtitle="Control pairing, appearance, and the mobile surface for remote operation."
          action={<StatusBadge label={`${connectedHostCount} online`} tone="success" />}
        />

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Hosts</SectionTitle>
            <IconButton icon={Plus} label="Pair" onPress={() => router.push("/pairing")} />
          </View>
          <Panel padded={false} style={styles.panelShell}>
            {hosts.length === 0 ? (
              <View style={styles.emptyHosts}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  No hosts paired
                </Text>
                <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>
                  Add a desktop target to enable thread browsing and remote control.
                </Text>
              </View>
            ) : (
              hosts.map((host, index) => {
                const isConnected = connections.some(
                  (connection) =>
                    connection.host.id === host.id && connection.status.kind === "connected",
                );

                return (
                  <View key={host.id}>
                    <RowLink
                      title={host.name}
                      meta={isConnected ? "Connected and syncing" : "Offline"}
                      tone={isConnected ? "success" : "muted"}
                      onPress={() =>
                        router.push({
                          pathname: "/settings/device/[id]",
                          params: { id: host.id },
                        })
                      }
                    />
                    {index < hosts.length - 1 ? (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    ) : null}
                  </View>
                );
              })
            )}
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>Appearance</SectionTitle>
          <Panel padded={false} style={styles.panelShell}>
            {THEME_OPTIONS.map((option, index) => {
              const selected = option.value === themeMode;
              const Icon = option.Icon;

              return (
                <Pressable
                  key={option.value}
                  onPress={() => setThemeMode(option.value)}
                  style={({ pressed }) => [
                    styles.themeRow,
                    {
                      backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.themeIcon,
                      {
                        backgroundColor: withAlpha(colors.primary, 0.12),
                      },
                    ]}
                  >
                    <Icon size={17} color={colors.primary} strokeWidth={2.2} />
                  </View>
                  <View style={styles.themeCopy}>
                    <Text style={[styles.themeTitle, { color: colors.foreground }]}>
                      {option.label}
                    </Text>
                    <Text style={[styles.themeMeta, { color: colors.secondaryLabel }]}>
                      {option.value === "system"
                        ? "Match the device"
                        : option.value === "dark"
                          ? "Low-glare workspace"
                          : "Bright canvas"}
                    </Text>
                  </View>
                  {selected ? <Check size={18} color={colors.primary} strokeWidth={2.8} /> : null}
                  {index < THEME_OPTIONS.length - 1 ? (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  ) : null}
                </Pressable>
              );
            })}
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>System</SectionTitle>
          <Panel style={styles.aboutPanel}>
            <View style={styles.aboutRow}>
              <View>
                <Text style={[styles.aboutLabel, { color: colors.secondaryLabel }]}>App</Text>
                <Text style={[styles.aboutValue, { color: colors.foreground }]}>
                  ace Mobile v0.1.6
                </Text>
              </View>
              <View
                style={[
                  styles.aboutBadge,
                  {
                    backgroundColor: withAlpha(colors.primary, 0.14),
                  },
                ]}
              >
                <SlidersHorizontal size={15} color={colors.primary} strokeWidth={2.2} />
              </View>
            </View>
            <Text style={[styles.aboutBody, { color: colors.secondaryLabel }]}>
              Pairing, preferences, and host routing are managed locally on this device.
            </Text>
          </Panel>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  panelShell: {
    overflow: "hidden",
  },
  emptyHosts: {
    padding: 20,
  },
  emptyTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  emptyBody: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
  },
  separator: {
    marginLeft: 18,
    marginRight: 18,
    height: StyleSheet.hairlineWidth,
  },
  themeRow: {
    minHeight: 78,
    paddingHorizontal: 18,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  themeIcon: {
    width: 40,
    height: 40,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  themeCopy: {
    flex: 1,
  },
  themeTitle: {
    fontSize: 17,
    lineHeight: 20,
    fontWeight: "700",
    letterSpacing: -0.25,
  },
  themeMeta: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  aboutPanel: {
    gap: 14,
  },
  aboutRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  aboutLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  aboutValue: {
    marginTop: 8,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "800",
    letterSpacing: -0.7,
  },
  aboutBody: {
    fontSize: 14,
    lineHeight: 21,
  },
  aboutBadge: {
    width: 42,
    height: 42,
    borderRadius: Radius.card,
    alignItems: "center",
    justifyContent: "center",
  },
});
