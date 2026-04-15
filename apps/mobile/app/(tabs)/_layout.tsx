import { Tabs } from "expo-router";
import { Home, MessageSquare, FolderOpen, Settings as SettingsIcon } from "lucide-react-native";
import { View } from "react-native";
import { useTheme } from "../../src/design/ThemeContext";

type TabIconComponent = typeof Home;

function TabIcon({
  Icon,
  color,
  focused,
}: {
  Icon: TabIconComponent;
  color: string;
  focused: boolean;
}) {
  return (
    <View
      style={{
        width: 42,
        height: 42,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? `${color}22` : "transparent",
      }}
    >
      <Icon color={color} size={20} strokeWidth={focused ? 2.6 : 2.3} />
    </View>
  );
}

export default function TabsLayout() {
  const { theme, isDark } = useTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.mutedForeground,
        tabBarShowLabel: false,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          borderTopWidth: 1,
          borderTopColor: theme.border,
          height: 76,
          paddingBottom: 12,
          paddingTop: 10,
          backgroundColor: isDark ? "#08090d" : "#fcfcfd",
        },
        tabBarItemStyle: {
          minHeight: 48,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon Icon={Home} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Threads",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon Icon={MessageSquare} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="threads"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon Icon={FolderOpen} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="control"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon Icon={SettingsIcon} color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
