import React from "react";
import { Tabs } from "expo-router";
import { Platform, StyleSheet } from "react-native";
import { LayoutGrid, MessageSquare, SlidersHorizontal } from "lucide-react-native";
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
          backgroundColor: colors.bg.canvas,
          borderTopColor: colors.border.soft,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: Platform.OS === "ios" ? 82 : 68,
          paddingTop: 8,
          paddingBottom: Platform.select({ ios: 18, default: 8 }),
          paddingHorizontal: 8,
          borderRadius: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarItemStyle: {
          borderRadius: 0,
          marginHorizontal: 4,
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
        name="index"
        options={{
          title: "Threads",
          tabBarIcon: ({ color }) => <MessageSquare size={22} color={color} strokeWidth={2.4} />,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color }) => <LayoutGrid size={22} color={color} strokeWidth={2.4} />,
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => (
            <SlidersHorizontal size={21} color={color} strokeWidth={2.4} />
          ),
        }}
      />
    </Tabs>
  );
}
