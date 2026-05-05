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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Radius, withAlpha } from "./system";
import { useTheme, type ThemeColors } from "./ThemeContext";
import { GlassBackground } from "./GlassBackground";

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

export function GlassScreenHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <GlassBackground
      style={[
        styles.glassHeaderContainer,
        {
          paddingTop: insets.top + 8,
          borderBottomColor: colors.separator,
        },
      ]}
    >
      <View style={styles.glassHeaderRow}>
        <View style={styles.glassHeaderCopy}>
          <Text style={[styles.glassTitle, { color: colors.foreground }]}>
            {title}
          </Text>
        </View>
        {action ? <View style={styles.glassHeaderAction}>{action}</View> : null}
      </View>
    </GlassBackground>
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
  return <Text style={[styles.sectionTitle, { color: colors.secondaryLabel }]}>{children}</Text>;
}

export function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: withAlpha(toneColor, 0.1),
          borderColor: withAlpha(toneColor, 0.15),
        },
      ]}
    >
      <View style={[styles.badgeDot, { backgroundColor: toneColor }]} />
      <Text style={[styles.badgeLabel, { color: toneColor }]}>{label}</Text>
    </View>
  );
}

export function MetricCard({
  label,
  value,
  tone = "muted",
  style,
}: {
  label: string;
  value: string | number;
  tone?: Tone;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.metricCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.elevatedBorder,
        },
        style,
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
  style,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.pillButton,
        {
          backgroundColor: colors.surfaceSecondary,
          borderColor: colors.elevatedBorder,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      <Icon size={16} color={colors.foreground} strokeWidth={2} />
      <Text style={[styles.pillButtonLabel, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

export function RowLink({
  icon: Icon,
  title,
  meta,
  tone,
  onPress,
}: {
  icon?: LucideIcon;
  title: string;
  meta: string;
  tone?: Tone;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const toneColor = tone ? resolveToneColor(colors, tone) : null;

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
      {Icon ? (
        <View
          style={[
            styles.rowIconWrap,
            {
              backgroundColor: toneColor ? withAlpha(toneColor, 0.12) : colors.surfaceSecondary,
            },
          ]}
        >
          <Icon size={18} color={toneColor ?? colors.secondaryLabel} strokeWidth={2.2} />
        </View>
      ) : null}
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.rowMeta, { color: colors.secondaryLabel }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <ChevronRight size={18} color={colors.tertiaryLabel} />
    </Pressable>
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
        styles.chip,
        {
          backgroundColor: selected ? withAlpha(colors.primary, 0.1) : colors.surfaceSecondary,
          borderColor: selected ? withAlpha(colors.primary, 0.4) : "transparent",
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.chipLabel,
          { color: selected ? colors.primary : colors.secondaryLabel },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  icon: Icon,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  icon?: LucideIcon;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.searchField,
        {
          backgroundColor: colors.surface,
          borderColor: colors.elevatedBorder,
        },
      ]}
    >
      {Icon ? (
        <Icon size={18} color={colors.tertiaryLabel} strokeWidth={2.2} style={styles.searchIcon} />
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.tertiaryLabel}
        style={[styles.searchInput, { color: colors.foreground }]}
      />
    </View>
  );
}

export function FormField(props: TextInputProps) {
  const { colors } = useTheme();

  return (
    <TextInput
      placeholderTextColor={colors.tertiaryLabel}
      style={[
        styles.formField,
        {
          backgroundColor: colors.surface,
          borderColor: colors.elevatedBorder,
          color: colors.foreground,
        },
        props.style,
      ]}
      {...props}
    />
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
    <View
      style={[
        styles.emptyState,
        {
          backgroundColor: colors.surface,
          borderColor: colors.elevatedBorder,
        },
      ]}
    >
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>{body}</Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function NoticeBanner({
  title,
  body,
  tone = "danger",
}: {
  title: string;
  body?: string;
  tone?: Tone;
}) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <View
      style={[
        styles.noticeBanner,
        {
          backgroundColor: withAlpha(toneColor, 0.1),
          borderColor: withAlpha(toneColor, 0.2),
        },
      ]}
    >
      <Text style={[styles.noticeTitle, { color: toneColor }]}>{title}</Text>
      {body ? (
        <Text style={[styles.noticeBody, { color: toneColor }]}>{body}</Text>
      ) : null}
    </View>
  );
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  const { colors } = useTheme();

  return (
    <View style={styles.skeletonContainer}>
      {Array.from({ length: rows }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.skeletonRow,
            { backgroundColor: colors.surface, borderColor: colors.elevatedBorder },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  glassHeaderContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 16,
    paddingHorizontal: 20,
  },
  glassHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  glassHeaderCopy: {
    flex: 1,
  },
  glassTitle: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  glassHeaderAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pillButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
  },
  pillButtonLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  headerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 20,
  },
  headerCopy: {
    flex: 1,
    minWidth: 200,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  headerAction: {
    paddingTop: 4,
  },
  panel: {
    borderRadius: Radius.panel,
    borderWidth: 1.5,
  },
  panelPadded: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  metricCard: {
    padding: 16,
    borderRadius: Radius.card,
    borderWidth: 1.5,
    minHeight: 100,
    justifyContent: "center",
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  rowLink: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
  },
  rowIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  rowMeta: {
    marginTop: 2,
    fontSize: 13,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: "700",
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: Radius.input,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    height: 52,
  },
  searchIcon: {
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  formField: {
    height: 52,
    borderRadius: Radius.input,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    fontSize: 15,
    fontWeight: "600",
  },
  emptyState: {
    padding: 24,
    borderRadius: Radius.panel,
    borderWidth: 1.5,
    alignItems: "flex-start",
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
  },
  emptyAction: {
    width: "100%",
  },
  noticeBanner: {
    padding: 16,
    borderRadius: Radius.card,
    borderWidth: 1.5,
    marginTop: 16,
  },
  noticeTitle: {
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 4,
  },
  noticeBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  skeletonContainer: {
    gap: 12,
  },
  skeletonRow: {
    height: 80,
    borderRadius: Radius.card,
    borderWidth: 1.5,
  },
});
