import React from "react";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { Cpu, Server, FolderOpen, Settings } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";

export default function TabsLayout() {
  const { colors, isDark } = useTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        headerShown: false,
        tabBarStyle: {
          backgroundColor: isDark ? "#1c1c1e" : "#f8f8f8",
          borderTopColor: colors.separator,
          borderTopWidth: Platform.select({ ios: 0.5, default: 1 }),
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Agents",
          tabBarIcon: ({ color, size }) => <Cpu size={size ?? 22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          title: "Hosts",
          tabBarIcon: ({ color, size }) => <Server size={size ?? 22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, size }) => <FolderOpen size={size ?? 22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Settings size={size ?? 22} color={color} />,
        }}
      />
    </Tabs>
  );
}
