import React, { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { ChevronRight } from "lucide-react-native";
import { Radius, withAlpha } from "./system";
import { useTheme, type ThemeColors } from "./ThemeContext";

type Tone = "accent" | "success" | "warning" | "danger" | "muted";

function resolveToneColor(colors: ThemeColors, tone: Tone): string {
  switch (tone) {
    case "success":
      return colors.green;
    case "warning":
      return colors.orange;
    case "danger":
      return colors.red;
    case "muted":
      return colors.muted;
    case "accent":
    default:
      return colors.primary;
  }
}

export function ScreenBackdrop() {
  const { colors } = useTheme();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          styles.orb,
          styles.orbTop,
          {
            backgroundColor: withAlpha(colors.primary, 0.12),
          },
        ]}
      />
      <View
        style={[
          styles.orb,
          styles.orbBottom,
          {
            backgroundColor: withAlpha(colors.surfaceTertiary, 0.5),
          },
        ]}
      />
    </View>
  );
}

export function ScreenHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  const { colors } = useTheme();

  return (
    <View style={styles.headerRow}>
      <View style={styles.headerCopy}>
        <Text style={[styles.eyebrow, { color: colors.tertiaryLabel }]}>{eyebrow}</Text>
        <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.secondaryLabel }]}>{subtitle}</Text>
        ) : null}
      </View>
      {action ? <View style={styles.headerAction}>{action}</View> : null}
    </View>
  );
}

export function Panel({
  children,
  style,
  padded = true,
}: {
  children: ReactNode;
  style?: ViewStyle;
  padded?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: colors.surface,
          borderColor: colors.elevatedBorder,
          shadowColor: colors.shadow,
        },
        padded && styles.panelPadded,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionTitle, { color: colors.tertiaryLabel }]}>{children}</Text>;
}

export function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: withAlpha(toneColor, 0.14),
          borderColor: withAlpha(toneColor, 0.2),
        },
      ]}
    >
      <View
        style={[
          styles.badgeDot,
          {
            backgroundColor: toneColor,
          },
        ]}
      />
      <Text style={[styles.badgeLabel, { color: toneColor }]}>{label}</Text>
    </View>
  );
}

export function MetricCard({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string | number;
  tone?: Tone;
}) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <View
      style={[
        styles.metricCard,
        {
          backgroundColor: colors.surfaceSecondary,
          borderColor: colors.elevatedBorder,
        },
      ]}
    >
      <Text style={[styles.metricLabel, { color: colors.secondaryLabel }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: colors.foreground }]}>{value}</Text>
      <View
        style={[
          styles.metricAccent,
          {
            backgroundColor: withAlpha(toneColor, 0.18),
          },
        ]}
      />
    </View>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: colors.surface,
          borderColor: colors.elevatedBorder,
          opacity: pressed ? 0.86 : 1,
        },
      ]}
    >
      <Icon size={16} color={colors.foreground} strokeWidth={2.2} />
      <Text style={[styles.iconButtonLabel, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

export function RowLink({
  icon: Icon,
  title,
  meta,
  tone = "muted",
  onPress,
}: {
  icon?: LucideIcon;
  title: string;
  meta?: string;
  tone?: Tone;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.rowLink,
        {
          backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
        },
      ]}
    >
      <View
        style={[
          styles.rowIcon,
          {
            backgroundColor: withAlpha(toneColor, 0.14),
          },
        ]}
      >
        {Icon ? <Icon size={16} color={toneColor} strokeWidth={2.1} /> : null}
      </View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        {meta ? (
          <Text style={[styles.rowMeta, { color: colors.secondaryLabel }]} numberOfLines={2}>
            {meta}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={16} color={colors.muted} strokeWidth={2.2} />
    </Pressable>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const { colors } = useTheme();

  return (
    <Panel>
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>{body}</Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  orb: {
    position: "absolute",
    borderRadius: 999,
  },
  orbTop: {
    top: -120,
    right: -80,
    width: 280,
    height: 280,
  },
  orbBottom: {
    bottom: -180,
    left: -120,
    width: 320,
    height: 320,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
  },
  headerCopy: {
    flex: 1,
  },
  headerAction: {
    paddingTop: 10,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 8,
    fontSize: 40,
    lineHeight: 42,
    fontWeight: "800",
    letterSpacing: -1.6,
  },
  subtitle: {
    marginTop: 10,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 320,
  },
  panel: {
    borderWidth: 1,
    borderRadius: Radius.panel,
    shadowOffset: { width: 0, height: 22 },
    shadowOpacity: 0.18,
    shadowRadius: 38,
    elevation: 0,
  },
  panelPadded: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.34,
    textTransform: "uppercase",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  badgeLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.16,
  },
  metricCard: {
    flex: 1,
    minHeight: 104,
    borderWidth: 1,
    borderRadius: Radius.card,
    paddingHorizontal: 16,
    paddingVertical: 14,
    justifyContent: "space-between",
    overflow: "hidden",
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  metricValue: {
    fontSize: 30,
    lineHeight: 32,
    fontWeight: "800",
    letterSpacing: -1.1,
  },
  metricAccent: {
    position: "absolute",
    right: -18,
    top: -18,
    width: 74,
    height: 74,
    borderRadius: 999,
  },
  iconButton: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconButtonLabel: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
  rowLink: {
    minHeight: 76,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 17,
    lineHeight: 20,
    fontWeight: "700",
    letterSpacing: -0.32,
  },
  rowMeta: {
    marginTop: 5,
    fontSize: 13,
    lineHeight: 18,
  },
  emptyTitle: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "800",
    letterSpacing: -0.7,
  },
  emptyBody: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
  },
  emptyAction: {
    marginTop: 18,
  },
});
