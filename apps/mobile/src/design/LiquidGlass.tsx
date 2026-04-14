import React, { useRef } from "react";
import { GlassView } from "expo-glass-effect";
import {
  Pressable,
  StyleSheet,
  Text,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  View,
  Animated,
} from "react-native";
import { useTheme } from "./ThemeContext";
import { canUseNativeGlass } from "./glassAvailability";

interface LiquidScreenProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

interface GlassGroupProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

interface GlassRowProps extends Omit<PressableProps, "style"> {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  scaleOnPress?: boolean;
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function LiquidScreen({ children, style }: LiquidScreenProps) {
  const { theme } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.background }, style]}>{children}</View>
  );
}

export function GlassGroup({ children, style }: GlassGroupProps) {
  const { isDark, theme } = useTheme();
  const useNativeGlass = canUseNativeGlass();
  const content = (
    <View
      style={[
        styles.groupContent,
        {
          borderColor: theme.border,
          backgroundColor: theme.card,
          borderWidth: isDark ? StyleSheet.hairlineWidth : 0,
        },
        style,
      ]}
    >
      {useNativeGlass && isDark ? (
        <GlassView
          pointerEvents="none"
          style={styles.groupNativeGlass}
          glassEffectStyle="regular"
          colorScheme={"dark"}
        />
      ) : null}
      {children}
    </View>
  );
  return content;
}

export function GlassRow({ children, style, scaleOnPress = true, ...props }: GlassRowProps) {
  const { isDark } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        {...props}
        onPressIn={(e) => {
          if (scaleOnPress) {
            Animated.timing(scale, {
              toValue: 0.97,
              duration: 100,
              useNativeDriver: true,
            }).start();
          }
          if (props.onPressIn) props.onPressIn(e);
        }}
        onPressOut={(e) => {
          if (scaleOnPress) {
            Animated.spring(scale, {
              toValue: 1,
              friction: 4,
              tension: 40,
              useNativeDriver: true,
            }).start();
          }
          if (props.onPressOut) props.onPressOut(e);
        }}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: pressed
              ? isDark
                ? "rgba(255,255,255,0.05)"
                : "rgba(0,0,0,0.04)"
              : "transparent",
          },
          style,
        ]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

export function RowSeparator({ inset = 62 }: { inset?: number }) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.separator,
        {
          marginLeft: inset,
          backgroundColor: theme.border,
        },
      ]}
    />
  );
}

export function SectionLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const { theme } = useTheme();
  return (
    <Text style={[styles.sectionLabel, { color: theme.mutedForeground }, style]}>{children}</Text>
  );
}

export function PageHeader({ title, subtitle, trailing, style }: PageHeaderProps) {
  const { theme } = useTheme();
  return (
    <View style={[styles.pageHeader, style]}>
      <View style={styles.pageHeaderText}>
        <Text style={[styles.pageTitle, { color: theme.foreground }]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.pageSubtitle, { color: theme.mutedForeground }]}>{subtitle}</Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.pageHeaderTrailing}>{trailing}</View> : null}
    </View>
  );
}

export function GlassIconOrb({ children }: { children: React.ReactNode }) {
  const { theme, isDark } = useTheme();
  return (
    <View
      style={[
        styles.iconOrb,
        {
          backgroundColor: isDark ? "rgba(255,255,255,0.08)" : theme.accent,
          borderWidth: 0,
        },
      ]}
    >
      {children}
    </View>
  );
}

export function GlassActionButton({
  children,
  onPress,
}: {
  children: React.ReactNode;
  onPress: ((event: GestureResponderEvent) => void) | undefined;
}) {
  const { isDark, theme } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={() => {
          Animated.timing(scale, {
            toValue: 0.92,
            duration: 100,
            useNativeDriver: true,
          }).start();
        }}
        onPressOut={() => {
          Animated.spring(scale, {
            toValue: 1,
            friction: 4,
            tension: 40,
            useNativeDriver: true,
          }).start();
        }}
        style={({ pressed }) => [
          styles.actionButton,
          {
            backgroundColor: pressed
              ? isDark
                ? "rgba(255,255,255,0.15)"
                : "rgba(0,0,0,0.08)"
              : theme.secondary,
          },
        ]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  groupContent: {
    borderRadius: 12,
    overflow: "hidden",
  },
  groupNativeGlass: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 12,
  },
  row: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: "center",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: -0.1,
    marginBottom: 8,
    marginLeft: 16,
    textTransform: "uppercase",
  },
  pageHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 20,
    paddingHorizontal: 16,
    gap: 12,
  },
  pageHeaderText: {
    flex: 1,
  },
  pageHeaderTrailing: {
    flexDirection: "row",
    alignItems: "center",
  },
  pageTitle: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "800",
    letterSpacing: -0.8,
  },
  pageSubtitle: {
    marginTop: 4,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "500",
  },
  iconOrb: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
