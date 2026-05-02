import React from "react";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { Bell, Bot, FolderTree, Settings2 } from "lucide-react-native";
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
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.12,
          marginBottom: Platform.select({ ios: 0, default: 2 }),
        },
        tabBarStyle: {
          position: "absolute",
          left: Layout.pagePadding,
          right: Layout.pagePadding,
          bottom: Platform.select({ ios: 18, default: 14 }),
          backgroundColor: isDark ? withAlpha("#0f141d", 0.97) : withAlpha("#ffffff", 0.96),
          borderTopColor: "transparent",
          borderTopWidth: 0,
          borderWidth: 1,
          borderColor: colors.elevatedBorder,
          height: Layout.tabBarHeight,
          paddingTop: 11,
          paddingBottom: Platform.select({ ios: 16, default: 10 }),
          paddingHorizontal: 10,
          borderRadius: Radius.panel,
          elevation: 0,
          shadowColor: colors.shadow,
          shadowOffset: { width: 0, height: 18 },
          shadowOpacity: 0.16,
          shadowRadius: 32,
        },
        tabBarItemStyle: { paddingVertical: 4 },
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
          title: "Notifications",
          tabBarIcon: ({ color, size }) => <Bell size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Settings2 size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}
