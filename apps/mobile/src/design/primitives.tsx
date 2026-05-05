import React, { type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
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
  return null;
}

export function ScreenHeader({
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  const { colors } = useTheme();

  return (
    <View style={styles.headerRow}>
      <View style={styles.headerCopy}>
        <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
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
          opacity: pressed ? 0.88 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
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
          transform: [{ scale: pressed ? 0.995 : 1 }],
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

export function SearchField({
  value,
  onChangeText,
  placeholder,
  icon: Icon,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  icon: LucideIcon;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.searchShell,
        {
          backgroundColor: colors.surface,
          borderColor: colors.elevatedBorder,
          shadowColor: colors.shadow,
        },
      ]}
    >
      <Icon size={17} color={colors.tertiaryLabel} strokeWidth={2.2} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={[styles.searchInput, { color: colors.foreground }]}
      />
    </View>
  );
}

export function FormField(props: TextInputProps) {
  const { colors } = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      {...props}
      style={[
        styles.formField,
        {
          color: colors.foreground,
          backgroundColor: colors.surfaceSecondary,
          borderColor: colors.elevatedBorder,
        },
        props.style,
      ]}
    />
  );
}

export function ChoiceChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceChip,
        {
          backgroundColor: selected ? colors.surface : colors.surfaceSecondary,
          borderColor: selected ? withAlpha(colors.primary, 0.44) : colors.elevatedBorder,
          opacity: pressed ? 0.92 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <Text
        style={[
          styles.choiceChipLabel,
          { color: selected ? colors.foreground : colors.secondaryLabel },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const { colors } = useTheme();
  return (
    <Panel padded={false} style={styles.skeletonShell}>
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <View
            style={[styles.skeletonLead, { backgroundColor: withAlpha(colors.foreground, 0.08) }]}
          />
          <View style={styles.skeletonCopy}>
            <View
              style={[
                styles.skeletonLinePrimary,
                { backgroundColor: withAlpha(colors.foreground, 0.1) },
              ]}
            />
            <View
              style={[
                styles.skeletonLineSecondary,
                { backgroundColor: withAlpha(colors.foreground, 0.07) },
              ]}
            />
          </View>
          {index < rows - 1 ? (
            <View style={[styles.separator, { backgroundColor: colors.separator }]} />
          ) : null}
        </View>
      ))}
    </Panel>
  );
}

export function NoticeBanner({
  tone = "muted",
  title,
  body,
}: {
  tone?: Tone;
  title: string;
  body?: string;
}) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <View
      style={[
        styles.noticeBanner,
        {
          backgroundColor: withAlpha(toneColor, 0.12),
          borderColor: withAlpha(toneColor, 0.24),
        },
      ]}
    >
      <Text style={[styles.noticeTitle, { color: toneColor }]}>{title}</Text>
      {body ? (
        <Text style={[styles.noticeBody, { color: colors.secondaryLabel }]}>{body}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  headerCopy: {
    flex: 1,
    minWidth: 200,
  },
  headerAction: {
    marginLeft: "auto",
    paddingTop: 4,
  },
  title: {
    fontSize: 28,
    lineHeight: 32,
    fontWeight: "700",
    letterSpacing: -0.8,
  },
  panel: {
    borderWidth: 1,
    borderRadius: Radius.panel,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 0,
  },
  panelPadded: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  metricCard: {
    flex: 1,
    minHeight: 80,
    borderWidth: 1,
    borderRadius: Radius.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: "space-between",
    overflow: "hidden",
  },
  metricLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  metricValue: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: "700",
    letterSpacing: -0.6,
  },
  iconButton: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  iconButtonLabel: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: -0.1,
  },
  rowLink: {
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  rowMeta: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 17,
  },
  emptyTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  emptyBody: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 20,
  },
  emptyAction: {
    marginTop: 16,
  },
  searchShell: {
    marginTop: 20,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 0,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "400",
  },
  formField: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    fontSize: 15,
    fontWeight: "400",
  },
  choiceChip: {
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  choiceChipLabel: {
    fontSize: 13,
    fontWeight: "500",
    letterSpacing: -0.1,
  },
  skeletonShell: {
    overflow: "hidden",
  },
  skeletonRow: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  skeletonLead: {
    width: 36,
    height: 36,
    borderRadius: 10,
  },
  skeletonCopy: {
    flex: 1,
    gap: 8,
  },
  skeletonLinePrimary: {
    width: "62%",
    height: 13,
    borderRadius: 6,
  },
  skeletonLineSecondary: {
    width: "86%",
    height: 11,
    borderRadius: 5,
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 16,
    right: 16,
    height: StyleSheet.hairlineWidth,
  },
  noticeBanner: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 3,
  },
  noticeTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "600",
  },
  noticeBody: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "400",
  },
});
