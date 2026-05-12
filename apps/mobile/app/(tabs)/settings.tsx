import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { Camera } from "expo-camera";
import {
  Bell,
  Camera as CameraIcon,
  Check,
  ChevronRight,
  CircleHelp,
  Monitor,
  Moon,
  Plus,
  Server,
  Sun,
  Wrench,
} from "lucide-react-native";
import { useTheme, type ThemeMode } from "../../src/design/ThemeContext";
import { Layout, withAlpha } from "../../src/design/system";
import {
  EmptyState,
  IconButton,
  InsetGroup,
  InsetRow,
  ScreenBackdrop,
  ScreenHeaderV2,
  SectionFooter,
  SectionTitle,
  SegmentedControl,
  StatusBadge,
} from "../../src/design/primitives";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { useAggregatedOrchestration } from "../../src/orchestration/mobileData";
import mobilePackage from "../../package.json";

const THEME_OPTIONS = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "System" },
] as const;

function permissionLabel(granted: boolean | null) {
  if (granted === null) {
    return "Checking";
  }
  return granted ? "Allowed" : "Not allowed";
}

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, themeMode, setThemeMode } = useTheme();
  const hosts = useHostStore((state) => state.hosts);
  const activeHostId = useHostStore((state) => state.activeHostId);
  const { connectedHostCount, projects, threads } = useAggregatedOrchestration();
  const [connections, setConnections] = useState<ReadonlyArray<ManagedConnection>>(() =>
    connectionManager.getConnections(),
  );
  const [notificationsGranted, setNotificationsGranted] = useState<boolean | null>(null);
  const [cameraGranted, setCameraGranted] = useState<boolean | null>(null);

  useEffect(() => {
    setConnections(connectionManager.getConnections());
    return connectionManager.onStatusChange(setConnections);
  }, []);

  useEffect(() => {
    let mounted = true;
    void Promise.all([Notifications.getPermissionsAsync(), Camera.getCameraPermissionsAsync()])
      .then(([notificationStatus, cameraStatus]) => {
        if (!mounted) {
          return;
        }
        setNotificationsGranted(notificationStatus.granted);
        setCameraGranted(cameraStatus.granted);
      })
      .catch(() => {
        if (!mounted) {
          return;
        }
        setNotificationsGranted(false);
        setCameraGranted(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const connectionStateByHostId = useMemo(() => {
    const map = new Map<string, { connected: boolean; error: string | null }>();
    for (const connection of connections) {
      map.set(connection.host.id, {
        connected: connection.status.kind === "connected",
        error:
          connection.status.kind === "disconnected" && connection.status.error
            ? connection.status.error
            : null,
      });
    }
    return map;
  }, [connections]);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 14,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
          gap: 22,
        }}
      >
        <ScreenHeaderV2
          title="Settings"
          subtitle="Appearance, paired hosts, permissions, and diagnostics for mobile thread control."
          actions={<IconButton icon={Plus} label="Pair" onPress={() => router.push("/pairing")} />}
        />

        <View style={styles.section}>
          <SectionTitle>Appearance</SectionTitle>
          <SegmentedControl
            options={THEME_OPTIONS}
            selectedKey={themeMode}
            onSelect={(key) => setThemeMode(key as ThemeMode)}
          />
          <InsetGroup>
            <InsetRow
              title="Theme"
              meta={
                themeMode === "system"
                  ? "Follow the device appearance"
                  : themeMode === "dark"
                    ? "Use the dark system palette"
                    : "Use the light system palette"
              }
              icon={themeMode === "system" ? Monitor : themeMode === "dark" ? Moon : Sun}
              trailing={
                <Text style={[styles.trailingText, { color: colors.text.tertiary }]}>
                  {themeMode === "system" ? "System" : themeMode === "dark" ? "Dark" : "Light"}
                </Text>
              }
              last
            />
          </InsetGroup>
          <SectionFooter>
            One palette, one type system, and one grouped layout grammar across every mobile route.
          </SectionFooter>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Hosts</SectionTitle>
            <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
              {connectedHostCount}/{hosts.length || 0} online
            </Text>
          </View>
          {hosts.length === 0 ? (
            <EmptyState
              title="No hosts paired"
              body="Pair an ace desktop host to browse projects and control live threads."
              action={
                <IconButton
                  icon={Plus}
                  label="Pair host"
                  onPress={() => router.push("/pairing")}
                  tone="primary"
                />
              }
            />
          ) : (
            <InsetGroup>
              {hosts.map((host, index) => {
                const state = connectionStateByHostId.get(host.id);
                const connected = state?.connected ?? false;
                const meta = state?.error ? state.error : host.wsUrl;
                const isActive = host.id === activeHostId;
                return (
                  <InsetRow
                    key={host.id}
                    title={host.name}
                    meta={meta}
                    icon={Server}
                    tone={connected ? "success" : state?.error ? "danger" : "muted"}
                    onPress={() =>
                      router.push({
                        pathname: "/host/[hostId]",
                        params: { hostId: host.id },
                      })
                    }
                    trailing={
                      <View style={styles.hostTrailing}>
                        {isActive ? (
                          <View
                            style={[
                              styles.defaultBadge,
                              { backgroundColor: withAlpha(colors.accent.primary, 0.12) },
                            ]}
                          >
                            <Check size={12} color={colors.accent.primary} strokeWidth={2.4} />
                            <Text
                              style={[styles.defaultBadgeText, { color: colors.accent.primary }]}
                            >
                              Default
                            </Text>
                          </View>
                        ) : null}
                        <StatusBadge
                          label={connected ? "Connected" : "Offline"}
                          tone={connected ? "success" : state?.error ? "danger" : "muted"}
                        />
                        <ChevronRight size={16} color={colors.text.tertiary} strokeWidth={2.1} />
                      </View>
                    }
                    last={index === hosts.length - 1}
                  />
                );
              })}
            </InsetGroup>
          )}
        </View>

        <View style={styles.section}>
          <SectionTitle>Permissions</SectionTitle>
          <InsetGroup>
            <InsetRow
              title="Local alerts"
              meta="Notifications surface approvals, errors, and agent attention while you are away."
              icon={Bell}
              trailing={
                <Text style={[styles.trailingText, { color: colors.text.tertiary }]}>
                  {permissionLabel(notificationsGranted)}
                </Text>
              }
            />
            <InsetRow
              title="Pairing camera"
              meta="Camera access is used only for scanning host pairing QR codes."
              icon={CameraIcon}
              onPress={() => router.push("/pairing")}
              trailing={
                <View style={styles.hostTrailing}>
                  <Text style={[styles.trailingText, { color: colors.text.tertiary }]}>
                    {permissionLabel(cameraGranted)}
                  </Text>
                  <ChevronRight size={16} color={colors.text.tertiary} strokeWidth={2.1} />
                </View>
              }
              last
            />
          </InsetGroup>
        </View>

        <View style={styles.section}>
          <SectionTitle>Provider & Diagnostics</SectionTitle>
          <InsetGroup>
            <InsetRow
              title="Advanced settings"
              meta="Provider binaries, diagnostics, archived items, and developer preferences."
              icon={Wrench}
              onPress={() => router.push("/profile")}
            />
            <InsetRow
              title="Search workspace"
              meta="Use one shared search flow for projects, threads, and hosts."
              icon={CircleHelp}
              onPress={() => router.push("/search")}
              last
            />
          </InsetGroup>
        </View>

        <View style={styles.section}>
          <SectionTitle>About</SectionTitle>
          <InsetGroup>
            <InsetRow
              title="Version"
              meta={`ace mobile ${mobilePackage.version}`}
              trailing={
                <Text style={[styles.trailingText, { color: colors.text.tertiary }]}>Build</Text>
              }
            />
            <InsetRow
              title="Projects in sync"
              meta={`${projects.length} projects currently visible across paired hosts.`}
              trailing={
                <Text style={[styles.trailingText, { color: colors.text.tertiary }]}>
                  {projects.length}
                </Text>
              }
            />
            <InsetRow
              title="Threads in sync"
              meta={`${threads.length} threads available for live control from mobile.`}
              trailing={
                <Text style={[styles.trailingText, { color: colors.text.tertiary }]}>
                  {threads.length}
                </Text>
              }
              last
            />
          </InsetGroup>
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
    gap: 10,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionMeta: {
    fontSize: 12,
  },
  trailingText: {
    fontSize: 12,
  },
  hostTrailing: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  defaultBadge: {
    alignItems: "center",
    borderRadius: 0,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  defaultBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
});
