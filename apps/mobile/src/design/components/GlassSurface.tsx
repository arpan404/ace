import React, { useMemo, type ReactNode } from "react";
import { Platform, StyleSheet, View, type ViewStyle } from "react-native";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { useTheme } from "../ThemeContext";

type GlassEffectStyle = React.ComponentProps<typeof GlassView>["glassEffectStyle"];

export function GlassSurface({
  children,
  style,
  fallbackColor,
  borderColor,
  tintColor,
  overlayColor,
  glassEffectStyle = "regular",
}: {
  children?: ReactNode;
  style?: ViewStyle;
  fallbackColor?: string;
  borderColor?: string;
  tintColor?: string;
  overlayColor?: string;
  glassEffectStyle?: GlassEffectStyle;
}) {
  const { colors, isDark } = useTheme();
  const glassAvailable = useMemo(() => {
    if (Platform.OS !== "ios") {
      return false;
    }

    try {
      return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
    } catch {
      return false;
    }
  }, []);

  const resolvedFallbackColor = fallbackColor ?? colors.surfaces.default;

  return (
    <View style={[styles.root, style]}>
      {glassAvailable ? (
        <>
          <GlassView
            style={StyleSheet.absoluteFill}
            colorScheme={isDark ? "dark" : "light"}
            glassEffectStyle={glassEffectStyle}
            {...(tintColor ? { tintColor } : {})}
          />
          {overlayColor ? (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { backgroundColor: overlayColor }]}
            />
          ) : null}
          {borderColor ? (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, styles.borderOverlay, { borderColor }]}
            />
          ) : null}
        </>
      ) : (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.borderOverlay,
            {
              backgroundColor: resolvedFallbackColor,
              borderColor: borderColor ?? "transparent",
            },
          ]}
        />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    overflow: "hidden",
  },
  borderOverlay: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
