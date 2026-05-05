import React from "react";
import { Tabs } from "expo-router";
import { Platform, StyleSheet } from "react-native";
import { LayoutGrid, MessageSquare, Server, SlidersHorizontal } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Typography } from "../../src/design/tokens";

export default function TabsLayout() {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: colors.bg.app },
        tabBarActiveTintColor: colors.accent.primary,
        tabBarInactiveTintColor: colors.text.tertiary,
        headerShown: false,
        tabBarShowLabel: true,
        tabBarLabelStyle: {
          ...Typography.roles.micro,
          fontSize: 11,
          marginTop: -4,
          marginBottom: Platform.select({ ios: 0, default: 4 }),
        },
        tabBarStyle: {
          position: "absolute",
          left: 12,
          right: 12,
          bottom: 10,
          backgroundColor: colors.surfaces.default,
          borderTopColor: colors.border.soft,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: Platform.OS === "ios" ? 78 : 70,
          paddingTop: 10,
          paddingBottom: Platform.select({ ios: 18, default: 10 }),
          paddingHorizontal: 10,
          borderRadius: 22,
          elevation: 0,
          shadowColor: colors.shadow,
          shadowOpacity: 0.06,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
        },
        tabBarItemStyle: {
          borderRadius: 16,
          marginHorizontal: 2,
        },
        tabBarIconStyle: {
          marginBottom: 1,
        },
      }}
    >
      <Tabs.Screen
        name="notifications"
        options={{
          href: null,
        }}
      />
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
          tabBarIcon: ({ color, size }) => (
            <MessageSquare size={22} color={color} strokeWidth={2.4} />
          ),
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          title: "Hosts",
          tabBarIcon: ({ color, size }) => <Server size={22} color={color} strokeWidth={2.4} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <SlidersHorizontal size={21} color={color} strokeWidth={2.4} />
          ),
        }}
      />
    </Tabs>
  );
}
