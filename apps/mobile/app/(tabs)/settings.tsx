import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Pressable, Text } from "react-native";
import { useRouter } from "expo-router";
import {
  CheckCircle2,
  ChevronRight,
  Monitor,
  Moon,
  Smartphone,
  Sun,
  Trash2,
  XCircle,
} from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import {
  SafeScreen,
  ScreenHeader,
  SectionHeader,
  List,
  ListItem,
  Card,
  Button,
} from "../../src/design/Components";

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme, themeMode, setThemeMode } = useTheme();
  const { hosts, removeHost } = useHostStore();
  const [connections, setConnections] = useState<ManagedConnection[]>([]);

  useEffect(() => {
    setConnections(connectionManager.getConnections());
    return connectionManager.onStatusChange((conns) => {
      setConnections(conns);
    });
  }, []);

  const themeOptions = [
    { label: "Light", icon: Sun, value: "light" as const },
    { label: "Dark", icon: Moon, value: "dark" as const },
    { label: "System", icon: Monitor, value: "system" as const },
  ];

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + 10, paddingBottom: 140 },
        ]}
      >
        <ScreenHeader title="Settings" subtitle="Hosts and app preferences" />

        <SectionHeader title="Hosts" />
        {hosts.length === 0 ? (
          <Card>
            <Text style={{ color: theme.mutedForeground, textAlign: "center" }}>
              Pair your first host to start using Ace.
            </Text>
          </Card>
        ) : (
          <List>
            {hosts.map((host) => {
              const conn = connections.find((c) => c.host.id === host.id);
              const isConnected = conn?.status.kind === "connected";

              return (
                <ListItem
                  key={host.id}
                  title={host.name}
                  subtitle={isConnected ? "Connected" : "Disconnected"}
                  onPress={() => {
                    router.push({ pathname: `/settings/device/[id]`, params: { id: host.id } });
                  }}
                  rightElement={
                    <View style={styles.hostActions}>
                      <Pressable
                        onPress={() => removeHost(host.id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Trash2 size={18} color={theme.dangerForeground} />
                      </Pressable>
                      <ChevronRight size={18} color={theme.mutedForeground} />
                    </View>
                  }
                  leftElement={
                    <View
                      style={[
                        styles.hostIcon,
                        { backgroundColor: isConnected ? `${theme.primary}1a` : theme.surface },
                      ]}
                    >
                      {isConnected ? (
                        <CheckCircle2 size={14} color={theme.primary} />
                      ) : (
                        <XCircle size={14} color={theme.mutedForeground} />
                      )}
                    </View>
                  }
                />
              );
            })}
          </List>
        )}

        <Button
          title="Pair host"
          onPress={() => router.push("/pairing")}
          variant="secondary"
          style={styles.addButton}
        />

        <SectionHeader title="Appearance" />
        <Card style={styles.themeCard}>
          <View style={styles.themeOptions}>
            {themeOptions.map((option) => {
              const Icon = option.icon;
              const isActive = themeMode === option.value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => setThemeMode(option.value)}
                  style={[
                    styles.themeButton,
                    {
                      backgroundColor: isActive ? theme.primary : theme.surface,
                      borderColor: isActive ? theme.primary : theme.border,
                    },
                  ]}
                >
                  <Icon size={20} color={isActive ? theme.primaryForeground : theme.foreground} />
                  <Text
                    style={{
                      color: isActive ? theme.primaryForeground : theme.foreground,
                      fontSize: 12,
                      fontWeight: "500",
                      marginTop: 4,
                    }}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <SectionHeader title="About" />
        <Card style={styles.aboutCard}>
          <View style={styles.aboutContent}>
            <View style={[styles.appIcon, { backgroundColor: `${theme.primary}1f` }]}>
              <Smartphone size={18} color={theme.primary} />
            </View>
            <Text style={[styles.aboutTitle, { color: theme.foreground }]}>Ace Mobile</Text>
            <Text style={[styles.aboutVersion, { color: theme.mutedForeground }]}>
              Version 1.0.0
            </Text>
            <Text style={[styles.aboutDescription, { color: theme.mutedForeground }]}>
              Native controls for coding agents, threads, and projects.
            </Text>
          </View>
        </Card>
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
  },
  addButton: {
    marginHorizontal: 0,
    marginTop: 14,
    marginBottom: 18,
  },
  themeCard: {
    paddingVertical: 16,
    paddingHorizontal: 12,
  },
  themeOptions: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  themeButton: {
    flex: 1,
    marginHorizontal: 4,
    paddingVertical: 12,
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
  },
  hostActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  hostIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  aboutCard: {
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  aboutContent: {
    alignItems: "center",
  },
  appIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  aboutTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 4,
  },
  aboutVersion: {
    fontSize: 13,
    marginBottom: 12,
  },
  aboutDescription: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
});
