import React from "react";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { Bell, Bot, FolderTree, Server, Settings2 } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";

export default function TabsLayout() {
  const { colors, isDark } = useTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        headerShown: false,
        tabBarShowLabel: true,
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: "700",
          letterSpacing: 0.12,
          marginBottom: Platform.select({ ios: 0, default: 2 }),
        },
        tabBarStyle: {
          position: "absolute",
          left: Layout.pagePadding,
          right: Layout.pagePadding,
          bottom: Platform.select({ ios: 18, default: 14 }),
          backgroundColor: isDark ? withAlpha("#0a111c", 0.98) : withAlpha("#f8fafc", 0.98),
          borderTopColor: "transparent",
          borderTopWidth: 0,
          borderWidth: 1,
          borderColor: colors.elevatedBorder,
          height: Layout.tabBarHeight,
          paddingTop: 10,
          paddingBottom: Platform.select({ ios: 14, default: 9 }),
          paddingHorizontal: 10,
          borderRadius: Radius.panel,
          elevation: 0,
          shadowColor: colors.shadow,
          shadowOffset: { width: 0, height: 12 },
          shadowOpacity: 0.2,
          shadowRadius: 24,
        },
        tabBarItemStyle: { paddingVertical: 3 },
        tabBarBackground: () => null,
      }}
    >
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, size }) => <FolderTree size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: "Threads",
          tabBarIcon: ({ color, size }) => <Bot size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: "Alerts",
          tabBarIcon: ({ color, size }) => <Bell size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          title: "Hosts",
          tabBarIcon: ({ color, size }) => <Server size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Settings2 size={size ?? 20} color={color} />,
        }}
      />
    </Tabs>
  );
}
