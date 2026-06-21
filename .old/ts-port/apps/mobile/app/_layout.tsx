import "react-native-get-random-values";
import { Stack } from "expo-router";
import { Platform, StatusBar } from "react-native";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "../src/design/ThemeContext";
import { initializeConnections } from "../src/store/HostStore";

function RootNavigator() {
  const { isDark, colors } = useTheme();

  return (
    <>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: Platform.OS === "ios" ? "default" : "fade_from_bottom",
          animationDuration: 250,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="pairing"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen name="project/[projectId]" options={{ animation: "default" }} />
        <Stack.Screen name="host/[hostId]" options={{ animation: "default" }} />
        <Stack.Screen name="thread/[threadId]" options={{ animation: "default" }} />
        <Stack.Screen
          name="thread/terminal"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen name="thread/browser" options={{ animation: "default" }} />
        <Stack.Screen name="settings/device/[id]" options={{ animation: "default" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void initializeConnections();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <RootNavigator />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
