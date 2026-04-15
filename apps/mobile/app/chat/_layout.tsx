import { Stack } from "expo-router";

export default function ChatLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "transparent" },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Threads" }} />
      <Stack.Screen name="[threadId]" options={{ title: "Thread" }} />
    </Stack>
  );
}
