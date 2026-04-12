import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { useTheme } from "../../src/design/ThemeContext";
import { GlassGroup, PageHeader } from "../../src/design/LiquidGlass";

export default function TerminalScreen() {
  const { theme } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: true, title: "", headerBackTitleVisible: false }} />
      <View style={styles.content}>
        <PageHeader title="Terminal" subtitle="Remote shell access" />
        <GlassGroup style={styles.shell}>
          <Text style={styles.text}>
            <Text style={{ color: "#22c55e" }}>ace@host</Text>
            <Text style={{ color: "#f5f7ff" }}>:~$ </Text>
            <Text style={{ color: "#f5f7ff" }}>connected to remote terminal</Text>
          </Text>
          <Text style={[styles.text, styles.dimText]}>
            Ready for input... (Interactive terminal implementation pending)
          </Text>
        </GlassGroup>
      </View>
      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: theme.mutedForeground }]}>
          Full terminal controls are coming in a follow-up update.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  shell: {
    flex: 1,
    borderRadius: 20,
    padding: 16,
    backgroundColor: "#020507",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
  },
  dimText: {
    marginTop: 10,
    color: "#8e98b0",
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 20,
    paddingTop: 10,
  },
  footerText: {
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
  },
  text: {
    fontFamily: "monospace",
    fontSize: 14,
    lineHeight: 20,
  },
});
