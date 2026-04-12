import { Tabs } from "expo-router";
import { House, FolderOpen, Settings } from "lucide-react-native";
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
          tabBarIcon: ({ color, size }) => <House color={color} size={size} />,
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
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Settings color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="threads"
        options={{
          href: null,
          headerShown: true,
          title: "",
          headerBackTitleVisible: false,
        }}
      />
    </Tabs>
  );
}
