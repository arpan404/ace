import React from "react";
import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { Bot, FolderTree, RadioTower, Settings2 } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";

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
          fontWeight: "600",
          letterSpacing: 0.2,
          marginBottom: Platform.select({ ios: -1, default: 1 }),
        },
        tabBarStyle: {
          backgroundColor: isDark ? "#101319" : "#f8f8f8",
          borderTopColor: colors.separator,
          borderTopWidth: Platform.select({ ios: 0.5, default: 1 }),
          height: Platform.select({ ios: 84, default: 72 }),
          paddingTop: 8,
          paddingBottom: Platform.select({ ios: 18, default: 10 }),
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Agents",
          tabBarIcon: ({ color, size }) => <Bot size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          title: "Hosts",
          tabBarIcon: ({ color, size }) => <RadioTower size={size ?? 20} color={color} />,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, size }) => <FolderTree size={size ?? 20} color={color} />,
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
