import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { FileDiff } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { GlassGroup, LiquidScreen, PageHeader } from "../../src/design/LiquidGlass";

export default function DiffScreen() {
  const { theme } = useTheme();

  return (
    <LiquidScreen>
      <Stack.Screen options={{ headerShown: true, title: "", headerBackTitleVisible: false }} />
      <View style={styles.container}>
        <PageHeader title="Diffs" subtitle="Review changes from active agent turns" />
        <GlassGroup style={styles.emptyState}>
          <View style={[styles.iconBox, { backgroundColor: theme.accent }]}>
            <FileDiff size={34} color={theme.primary} />
          </View>
          <Text style={[styles.title, { color: theme.foreground }]}>No active diffs</Text>
          <Text style={[styles.subtitle, { color: theme.mutedForeground }]}>
            Once a turn produces file changes, they will appear here.
          </Text>
        </GlassGroup>
      </View>
    </LiquidScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 20,
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 30,
    borderRadius: 20,
    gap: 8,
  },
  iconBox: {
    width: 64,
    height: 64,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    marginTop: 8,
    fontSize: 20,
    fontWeight: "700",
  },
  subtitle: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
});
