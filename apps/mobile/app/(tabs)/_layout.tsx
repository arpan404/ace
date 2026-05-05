import React from "react";
import { Tabs } from "expo-router";
import { Platform, StyleSheet, View } from "react-native";
import { Bell, LayoutGrid, MessageSquare } from "lucide-react-native";
import { GlassView } from "expo-glass-effect";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";

export default function TabsLayout() {
  const { colors, isDark } = useTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.tertiaryLabel,
        headerShown: false,
        tabBarShowLabel: true,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
          marginTop: -4,
          marginBottom: Platform.select({ ios: 0, default: 4 }),
        },
        tabBarStyle: {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "transparent",
          borderTopColor: colors.separator,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: Platform.OS === "ios" ? 88 : 64,
          paddingTop: 12,
          paddingBottom: Platform.select({ ios: 28, default: 8 }),
          elevation: 0,
        },
        tabBarBackground: () => (
          <GlassView style={StyleSheet.absoluteFill} />
        ),
      }}
    >
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, size }) => <LayoutGrid size={22} color={color} strokeWidth={2.4} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: "Threads",
          tabBarIcon: ({ color, size }) => <MessageSquare size={22} color={color} strokeWidth={2.4} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: "Alerts",
          tabBarIcon: ({ color, size }) => <Bell size={22} color={color} strokeWidth={2.4} />,
        }}
      />
    </Tabs>
  );
}
