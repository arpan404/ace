import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight, Laptop, Plus, Info, Sun, Moon, Monitor } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import {
  GlassGroup,
  GlassIconOrb,
  GlassRow,
  LiquidScreen,
  PageHeader,
  RowSeparator,
  SectionLabel,
} from "../../src/design/LiquidGlass";

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme, themeMode, setThemeMode } = useTheme();
  const { hosts } = useHostStore();
  const [connections, setConnections] = useState<ManagedConnection[]>([]);

  useEffect(() => {
    setConnections(connectionManager.getConnections());
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
    });
  }, []);

  return (
    <LiquidScreen>
      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 20 }]}>
        <PageHeader title="Settings" />

        <View style={styles.section}>
          <SectionLabel>Devices</SectionLabel>
          <GlassGroup>
            {hosts.length === 0 ? (
              <GlassRow scaleOnPress={false}>
                <Text style={{ color: theme.mutedForeground }}>No devices configured yet.</Text>
              </GlassRow>
            ) : (
              hosts.map((host) => {
                const conn = connections.find((c) => c.host.id === host.id);
                const isConnected = conn?.status.kind === "connected";

                return (
                  <React.Fragment key={host.id}>
                    <GlassRow
                      onPress={() =>
                        router.push({ pathname: `/settings/device/[id]`, params: { id: host.id } })
                      }
                    >
                      <View style={styles.itemLeft}>
                        <GlassIconOrb>
                          <Laptop
                            size={18}
                            color={isConnected ? theme.primaryForeground : theme.foreground}
                          />
                        </GlassIconOrb>
                        <View>
                          <Text style={[styles.itemName, { color: theme.foreground }]}>
                            {host.name}
                          </Text>
                          <Text
                            style={[
                              styles.itemSub,
                              { color: isConnected ? theme.primary : theme.mutedForeground },
                            ]}
                          >
                            {isConnected ? "Connected" : "Disconnected"}
                          </Text>
                        </View>
                      </View>
                      <ChevronRight size={20} color={theme.mutedForeground} />
                    </GlassRow>
                    <RowSeparator inset={56} />
                  </React.Fragment>
                );
              })
            )}
            <GlassRow onPress={() => router.push("/pairing")}>
              <View style={styles.itemLeft}>
                <View style={[styles.addIconWrap, { backgroundColor: theme.primary }]}>
                  <Plus size={16} color={theme.primaryForeground} />
                </View>
                <Text style={[styles.itemName, { color: theme.primary }]}>
                  Add Device Instance...{" "}
                </Text>
              </View>
            </GlassRow>
          </GlassGroup>
        </View>

        <View style={styles.section}>
          <SectionLabel>Appearance</SectionLabel>
          <GlassGroup>
            <GlassRow scaleOnPress={false} style={{ paddingVertical: 14 }}>
              <View style={[styles.modeSelector, { backgroundColor: theme.secondary }]}>
                {(["system", "light", "dark"] as const).map((mode) => {
                  const isSelected = themeMode === mode;
                  const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
                  return (
                    <Pressable
                      key={mode}
                      onPress={() => setThemeMode(mode)}
                      style={[
                        styles.modeButton,
                        {
                          backgroundColor: isSelected ? theme.card : "transparent",
                          shadowOpacity: isSelected ? 0.05 : 0,
                          borderColor: isSelected ? theme.border : "transparent",
                          borderWidth: isSelected ? StyleSheet.hairlineWidth : 0,
                        },
                      ]}
                    >
                      <Icon size={16} color={isSelected ? theme.foreground : theme.info} />
                      <Text
                        style={[
                          styles.modeButtonLabel,
                          {
                            color: isSelected ? theme.foreground : theme.info,
                          },
                        ]}
                      >
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </GlassRow>
          </GlassGroup>
        </View>

        <View style={styles.section}>
          <SectionLabel>About</SectionLabel>
          <GlassGroup>
            <GlassRow style={styles.aboutRow}>
              <View style={styles.itemLeft}>
                <GlassIconOrb>
                  <Info size={18} color={theme.foreground} />
                </GlassIconOrb>
                <Text style={[styles.itemName, { color: theme.foreground }]}>ace Mobile</Text>
              </View>
              <View style={styles.aboutMeta}>
                <Text style={[styles.aboutVersion, { color: theme.mutedForeground }]}>0.0.1</Text>
                <ChevronRight size={20} color={theme.mutedForeground} />
              </View>
            </GlassRow>
          </GlassGroup>
        </View>
      </ScrollView>
    </LiquidScreen>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 140,
  },
  section: {
    paddingHorizontal: 16,
    marginBottom: 26,
  },
  itemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    flex: 1,
  },
  itemName: {
    fontSize: 16,
    fontWeight: "500",
  },
  itemSub: {
    fontSize: 13,
    marginTop: 2,
    fontWeight: "400",
  },
  addIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  modeSelector: {
    flexDirection: "row",
    alignItems: "center",
    padding: 3,
    borderRadius: 12,
    width: "100%",
  },
  modeButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  modeButtonLabel: {
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: -0.1,
  },
  aboutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  aboutMeta: {
    flexDirection: "row",
    alignItems: "center",
  },
  aboutVersion: {
    fontSize: 15,
    marginRight: 4,
  },
});
