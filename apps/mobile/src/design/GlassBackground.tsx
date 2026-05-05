import React from "react";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import { GlassView } from "expo-glass-effect";
import { useTheme } from "./ThemeContext";

export function GlassBackground({ style, children, ...rest }: ViewProps) {
  const { colors, isDark } = useTheme();

  if (Platform.OS === "ios") {
    return (
      <View style={[styles.container, style]} {...rest}>
        <GlassView style={StyleSheet.absoluteFill} />
        {children}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: isDark ? colors.surface : colors.surfaceSecondary, elevation: 4 },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
});
