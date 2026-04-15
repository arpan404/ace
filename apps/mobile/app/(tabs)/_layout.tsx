import { Tabs } from "expo-router";
import {
  Home,
  MessageSquare,
  FolderOpen,
  Sliders,
  Settings as SettingsIcon,
} from "lucide-react-native";
import { Platform, View } from "react-native";
import { GlassView } from "expo-glass-effect";
import { useTheme } from "../../src/design/ThemeContext";
import { canUseNativeGlass } from "../../src/design/glassAvailability";

export default function TabsLayout() {
  const { theme, isDark } = useTheme();
  const useNativeGlass = canUseNativeGlass();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          borderTopWidth: 0,
          height: 82,
          paddingBottom: 8,
          paddingTop: 8,
          backgroundColor: Platform.OS === "ios" ? "transparent" : theme.background,
        },
        tabBarBackground: () =>
          Platform.OS === "ios" ? (
            useNativeGlass ? (
              <GlassView
                style={{ flex: 1, borderTopWidth: 1, borderTopColor: theme.border }}
                glassEffectStyle="regular"
                colorScheme={isDark ? "dark" : "light"}
              />
            ) : (
              <View
                style={{
                  flex: 1,
                  borderTopWidth: 1,
                  borderTopColor: theme.border,
                  backgroundColor: isDark ? "rgba(8, 10, 15, 0.92)" : "rgba(255, 255, 255, 0.92)",
                }}
              />
            )
          ) : undefined,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: ({ color, size }) => <MessageSquare color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, size }) => <FolderOpen color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="control"
        options={{
          title: "Control",
          tabBarIcon: ({ color, size }) => <Sliders color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <SettingsIcon color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
