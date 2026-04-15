import { Stack } from "expo-router";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "../src/design/ThemeContext";

function RootNavigator() {
  const { isDark, colors } = useTheme();

  return (
    <>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pairing" options={{ presentation: "modal" }} />
        <Stack.Screen name="host/[hostId]" options={{ presentation: "card" }} />
        <Stack.Screen name="thread/[threadId]" options={{ presentation: "card" }} />
        <Stack.Screen name="thread/terminal" options={{ presentation: "card" }} />
        <Stack.Screen name="thread/browser" options={{ presentation: "card" }} />
        <Stack.Screen name="settings/device/[id]" options={{ presentation: "card" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <RootNavigator />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
