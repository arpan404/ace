import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, Pressable, Text, Switch } from "react-native";
import { useRouter } from "expo-router";
import { Sun, Moon, Monitor, Trash2 } from "lucide-react-native";
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
          { paddingTop: insets.top + 12, paddingBottom: 140 },
        ]}
      >
        <ScreenHeader title="Settings" subtitle="Configuration & preferences" />

        {/* Hosts Section */}
        <SectionHeader title="Hosts" />
        {hosts.length === 0 ? (
          <Card>
            <Text style={{ color: theme.mutedForeground, textAlign: "center" }}>
              No hosts configured yet
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
                    <Pressable
                      onPress={() => removeHost(host.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Trash2 size={18} color={theme.dangerForeground} />
                    </Pressable>
                  }
                />
              );
            })}
          </List>
        )}

        <Button
          title="Add New Host"
          onPress={() => router.push("/pairing")}
          variant="secondary"
          style={styles.addButton}
        />

        {/* Theme Section */}
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

        {/* Notification Section */}
        <SectionHeader title="Notifications" />
        <List>
          <ListItem
            title="Push Notifications"
            subtitle="Receive updates from your hosts"
            rightElement={<Switch value={true} />}
          />
          <ListItem
            title="Sound Alerts"
            subtitle="Play sound for important events"
            rightElement={<Switch value={true} />}
          />
        </List>

        {/* About Section */}
        <SectionHeader title="About" />
        <Card style={styles.aboutCard}>
          <View style={styles.aboutContent}>
            <Text style={[styles.aboutTitle, { color: theme.foreground }]}>Ace Mobile</Text>
            <Text style={[styles.aboutVersion, { color: theme.mutedForeground }]}>
              Version 1.0.0
            </Text>
            <Text style={[styles.aboutDescription, { color: theme.mutedForeground }]}>
              A mobile interface for controlling coding agents and managing projects.
            </Text>
          </View>
        </Card>

        {/* Advanced Section */}
        <SectionHeader title="Advanced" />
        <List>
          <ListItem
            title="Debug Mode"
            subtitle="Enable verbose logging"
            rightElement={<Switch value={false} />}
          />
          <ListItem
            title="WebSocket History"
            subtitle="View connection logs"
            onPress={() => {
              // Could navigate to debug screen
            }}
          />
        </List>
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
    marginVertical: 16,
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
  aboutCard: {
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  aboutContent: {
    alignItems: "center",
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
