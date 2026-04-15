import { Tabs } from "expo-router";
import { Platform } from "react-native";
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
          tabBarIcon: ({ color }) => tabIcon("bolt.fill", color),
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          title: "Hosts",
          tabBarIcon: ({ color }) => tabIcon("server.rack", color),
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color }) => tabIcon("folder.fill", color),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => tabIcon("gearshape.fill", color),
        }}
      />
    </Tabs>
  );
}

function tabIcon(_name: string, color: string) {
  // Expo Router tab icons are rendered natively on iOS via SF Symbols
  // when using systemImage. For RN fallback, use a simple circle indicator.
  const React = require("react");
  const { View } = require("react-native");
  return React.createElement(View, {
    style: {
      width: 22,
      height: 22,
      borderRadius: 6,
      backgroundColor: color,
      opacity: 0.85,
    },
  });
}
