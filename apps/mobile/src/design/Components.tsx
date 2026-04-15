import React from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  type ViewStyle,
} from "react-native";
import { useTheme } from "./ThemeContext";

// ===== UTILITY COMPONENTS =====

export function SafeScreen({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return <View style={[styles.screen, { backgroundColor: theme.background }]}>{children}</View>;
}

export function ScrollableScreen({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <ScrollView style={[styles.screen, { backgroundColor: theme.background }]}>
      {children}
    </ScrollView>
  );
}

// ===== HEADER COMPONENTS =====

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  rightElement?: React.ReactNode;
  style?: ViewStyle;
}

export function ScreenHeader({ title, subtitle, rightElement, style }: ScreenHeaderProps) {
  const { theme } = useTheme();
  return (
    <View style={[styles.screenHeader, style]}>
      <View style={styles.headerTitle}>
        <Text style={[styles.headerTitleText, { color: theme.foreground }]}>{title}</Text>
        {subtitle && (
          <Text style={[styles.headerSubtitleText, { color: theme.mutedForeground }]}>
            {subtitle}
          </Text>
        )}
      </View>
      {rightElement && <View>{rightElement}</View>}
    </View>
  );
}

interface SectionHeaderProps {
  title: string;
  action?: React.ReactNode;
}

export function SectionHeader({ title, action }: SectionHeaderProps) {
  const { theme } = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionHeaderText, { color: theme.mutedForeground }]}>
        {title.toUpperCase()}
      </Text>
      {action && <View>{action}</View>}
    </View>
  );
}

// ===== CARD & CONTAINER COMPONENTS =====

interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  highlighted?: boolean;
}

export function Card({ children, onPress, style, highlighted }: CardProps) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: highlighted ? theme.activeSurface : theme.surface,
          borderColor: theme.border,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

interface GroupProps {
  children: React.ReactNode;
  title?: string;
  style?: ViewStyle;
}

export function Group({ children, title, style }: GroupProps) {
  const { theme } = useTheme();
  return (
    <View style={[styles.group, style]}>
      {title && (
        <Text style={[styles.groupTitle, { color: theme.mutedForeground }]}>
          {title.toUpperCase()}
        </Text>
      )}
      {children}
    </View>
  );
}

interface ListProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

export function List({ children, style }: ListProps) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.list,
        {
          backgroundColor: theme.surface,
          borderColor: theme.border,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

interface ListItemProps {
  onPress?: () => void;
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
  title: string;
  subtitle?: string;
  style?: ViewStyle;
  highlighted?: boolean;
}

export function ListItem({
  onPress,
  leftElement,
  rightElement,
  title,
  subtitle,
  style,
  highlighted,
}: ListItemProps) {
  const { theme, isDark } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.listItem,
        {
          backgroundColor: highlighted
            ? theme.activeSurface
            : pressed
              ? isDark
                ? "rgba(255,255,255,0.05)"
                : "rgba(0,0,0,0.04)"
              : theme.surface,
        },
        style,
      ]}
    >
      {leftElement && <View style={styles.listItemLeft}>{leftElement}</View>}
      <View style={styles.listItemContent}>
        <Text style={[styles.listItemTitle, { color: theme.foreground }]}>{title}</Text>
        {subtitle && (
          <Text style={[styles.listItemSubtitle, { color: theme.mutedForeground }]}>
            {subtitle}
          </Text>
        )}
      </View>
      {rightElement && <View style={styles.listItemRight}>{rightElement}</View>}
    </Pressable>
  );
}

// ===== BUTTON COMPONENTS =====

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "destructive";
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  style,
}: ButtonProps) {
  const { theme } = useTheme();

  let bgColor = theme.primary;
  let textColor = theme.primaryForeground;

  if (variant === "secondary") {
    bgColor = theme.surface;
    textColor = theme.foreground;
  } else if (variant === "destructive") {
    bgColor = theme.dangerSurface;
    textColor = theme.dangerForeground;
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: bgColor,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} size="small" />
      ) : (
        <Text style={[styles.buttonText, { color: textColor }]}>{title}</Text>
      )}
    </Pressable>
  );
}

interface SmallButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  icon?: React.ReactNode;
  style?: ViewStyle;
}

export function SmallButton({
  title,
  onPress,
  variant = "primary",
  icon,
  style,
}: SmallButtonProps) {
  const { theme } = useTheme();

  const bgColor = variant === "primary" ? theme.primary : theme.surface;
  const textColor = variant === "primary" ? theme.primaryForeground : theme.foreground;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.smallButton,
        {
          backgroundColor: bgColor,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {icon && <View style={styles.smallButtonIcon}>{icon}</View>}
      <Text style={[styles.smallButtonText, { color: textColor }]}>{title}</Text>
    </Pressable>
  );
}

// ===== STATUS & LOADING COMPONENTS =====

interface StatusBadgeProps {
  status: "connected" | "connecting" | "disconnected" | "error";
  label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const { theme } = useTheme();

  let bgColor = theme.mutedForeground;
  let textColor = theme.foreground;

  if (status === "connected") {
    bgColor = "#10b981";
    textColor = "white";
  } else if (status === "disconnected") {
    bgColor = theme.mutedForeground;
  } else if (status === "error") {
    bgColor = theme.dangerSurface;
    textColor = theme.dangerForeground;
  }

  return (
    <View style={[styles.badge, { backgroundColor: bgColor }]}>
      <Text style={[styles.badgeText, { color: textColor }]}>
        {label || status.charAt(0).toUpperCase() + status.slice(1)}
      </Text>
    </View>
  );
}

interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
}

export function LoadingOverlay({ visible, message }: LoadingOverlayProps) {
  if (!visible) return null;
  const { theme } = useTheme();
  return (
    <View style={[styles.overlay, { backgroundColor: "rgba(0,0,0,0.6)" }]}>
      <View
        style={[
          styles.loadingBox,
          {
            backgroundColor: theme.surface,
            borderColor: theme.border,
          },
        ]}
      >
        <ActivityIndicator size="large" color={theme.primary} />
        {message && (
          <Text style={[styles.loadingMessage, { color: theme.foreground }]}>{message}</Text>
        )}
      </View>
    </View>
  );
}

interface ErrorBoxProps {
  message: string;
  onDismiss?: () => void;
}

export function ErrorBox({ message, onDismiss }: ErrorBoxProps) {
  const { theme } = useTheme();
  return (
    <View style={[styles.errorBox, { backgroundColor: theme.dangerSurface }]}>
      <Text style={[styles.errorText, { color: theme.dangerForeground }]}>{message}</Text>
      {onDismiss && (
        <Pressable onPress={onDismiss} style={styles.errorDismiss}>
          <Text style={[styles.errorDismissText, { color: theme.dangerForeground }]}>✕</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  screenHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    flex: 1,
  },
  headerTitleText: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  headerSubtitleText: {
    fontSize: 14,
    marginTop: 4,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionHeaderText: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  card: {
    padding: 16,
    borderRadius: 12,
    marginHorizontal: 16,
    marginVertical: 8,
    borderWidth: 1,
  },
  group: {
    marginVertical: 8,
  },
  groupTitle: {
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 16,
    paddingVertical: 8,
    letterSpacing: 0.5,
  },
  list: {
    borderRadius: 12,
    overflow: "hidden",
    marginHorizontal: 16,
    marginVertical: 8,
    borderWidth: 1,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "transparent",
  },
  listItemLeft: {
    marginRight: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  listItemContent: {
    flex: 1,
  },
  listItemTitle: {
    fontSize: 16,
    fontWeight: "500",
  },
  listItemSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  listItemRight: {
    marginLeft: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  smallButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  smallButtonIcon: {
    marginRight: 6,
  },
  smallButtonText: {
    fontSize: 13,
    fontWeight: "500",
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1000,
  },
  loadingBox: {
    padding: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
  },
  loadingMessage: {
    fontSize: 14,
    marginTop: 12,
  },
  errorBox: {
    marginHorizontal: 16,
    marginVertical: 8,
    padding: 12,
    borderRadius: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  errorText: {
    fontSize: 14,
    fontWeight: "500",
    flex: 1,
  },
  errorDismiss: {
    padding: 8,
  },
  errorDismissText: {
    fontSize: 18,
    fontWeight: "600",
  },
});
