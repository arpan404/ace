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
import { Typography } from "./tokens";
import type { ActionTone, StatusTone } from "./roles";

function resolveToneColor(colors: ThemeColors, tone: StatusTone): string {
  switch (tone) {
    case "success":
      return colors.status.success;
    case "warning":
      return colors.status.warning;
    case "danger":
      return colors.status.danger;
    case "info":
      return colors.status.info;
    case "muted":
      return colors.status.muted;
    case "accent":
    default:
      return colors.accent.primary;
  }
}

function resolveActionColors(colors: ThemeColors, tone: ActionTone) {
  switch (tone) {
    case "primary":
      return {
        backgroundColor: colors.accent.primary,
        borderColor: colors.accent.primary,
        color: colors.text.inverse,
      };
    case "danger":
      return {
        backgroundColor: withAlpha(colors.status.danger, 0.12),
        borderColor: withAlpha(colors.status.danger, 0.22),
        color: colors.status.danger,
      };
    case "quiet":
      return {
        backgroundColor: "transparent",
        borderColor: "transparent",
        color: colors.text.secondary,
      };
    case "neutral":
    default:
      return {
        backgroundColor: colors.surfaces.muted,
        borderColor: colors.border.strong,
        color: colors.text.primary,
      };
  }
}

export function ScreenBackdrop() {
  const { colors } = useTheme();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.backdropBase, { backgroundColor: colors.bg.app }]} />
      <View
        style={[
          styles.backdropOrbLarge,
          { backgroundColor: withAlpha(colors.accent.primary, 0.055) },
        ]}
      />
      <View
        style={[styles.backdropOrbSmall, { backgroundColor: withAlpha(colors.status.info, 0.05) }]}
      />
    </View>
  );
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
  return <ScreenHeaderV2 title={title} actions={action} />;
}

export function GlassScreenHeader({ title, action }: { title: string; action?: ReactNode }) {
  return <ScreenHeaderV2 title={title} actions={action} sticky />;
}

export function ScreenHeaderV2({
  title,
  eyebrow,
  subtitle,
  actions,
  sticky = false,
}: {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  actions?: ReactNode;
  sticky?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.headerShell,
        sticky && {
          backgroundColor: withAlpha(colors.bg.app, 0.96),
          borderBottomColor: colors.border.soft,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          {eyebrow ? (
            <Text style={[styles.headerEyebrow, { color: colors.text.tertiary }]}>{eyebrow}</Text>
          ) : null}
          <Text style={[styles.headerTitle, { color: colors.text.primary }]}>{title}</Text>
          {subtitle ? (
            <Text
              style={[styles.headerSubtitle, { color: colors.text.secondary }]}
              numberOfLines={2}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {actions ? <View style={styles.headerActions}>{actions}</View> : null}
      </View>
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
          backgroundColor: colors.surfaces.default,
          borderColor: colors.border.soft,
        },
        padded && styles.panelPadded,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionCard({
  title,
  meta,
  action,
  children,
  style,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  children: ReactNode;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  return (
    <Panel {...(style ? { style } : {})}>
      <View style={styles.sectionCardHeader}>
        <View style={styles.sectionCardCopy}>
          <Text style={[styles.sectionCardTitle, { color: colors.text.primary }]}>{title}</Text>
          {meta ? (
            <Text style={[styles.sectionCardMeta, { color: colors.text.secondary }]}>{meta}</Text>
          ) : null}
        </View>
        {action}
      </View>
      {children}
    </Panel>
  );
}

export function UtilityCard({
  label,
  value,
  meta,
  tone = "muted",
  style,
}: {
  label: string;
  value: string | number;
  meta?: string;
  tone?: StatusTone;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);
  return (
    <View
      style={[
        styles.utilityCard,
        {
          backgroundColor: colors.surfaces.default,
          borderColor: colors.border.soft,
        },
        style,
      ]}
    >
      <Text style={[styles.utilityCardLabel, { color: colors.text.secondary }]}>{label}</Text>
      <Text style={[styles.utilityCardValue, { color: colors.text.primary }]}>{value}</Text>
      {meta ? (
        <View style={styles.utilityMetaRow}>
          <View style={[styles.inlineDot, { backgroundColor: toneColor }]} />
          <Text style={[styles.utilityCardMeta, { color: colors.text.tertiary }]}>{meta}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionTitle, { color: colors.text.tertiary }]}>{children}</Text>;
}

export function InlineStatusDot({ tone = "accent" }: { tone?: StatusTone }) {
  const { colors } = useTheme();
  return <View style={[styles.inlineDot, { backgroundColor: resolveToneColor(colors, tone) }]} />;
}

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: withAlpha(toneColor, 0.1),
          borderColor: withAlpha(toneColor, 0.16),
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
  tone?: StatusTone;
  style?: ViewStyle;
}) {
  return <UtilityCard label={label} value={value} tone={tone} {...(style ? { style } : {})} />;
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
  style,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  style?: ViewStyle;
  tone?: ActionTone;
}) {
  const { colors } = useTheme();
  const actionColors = resolveActionColors(colors, tone);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: actionColors.backgroundColor,
          borderColor: actionColors.borderColor,
          opacity: pressed ? 0.72 : 1,
        },
        style,
      ]}
    >
      <Icon size={16} color={actionColors.color} strokeWidth={2.1} />
      <Text style={[styles.iconButtonLabel, { color: actionColors.color }]}>{label}</Text>
    </Pressable>
  );
}

export function ActionChip({
  icon: Icon,
  label,
  onPress,
  tone = "neutral",
}: {
  icon?: LucideIcon;
  label: string;
  onPress: () => void;
  tone?: ActionTone;
}) {
  const { colors } = useTheme();
  const actionColors = resolveActionColors(colors, tone);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionChip,
        {
          backgroundColor: actionColors.backgroundColor,
          borderColor: actionColors.borderColor,
          opacity: pressed ? 0.76 : 1,
        },
      ]}
    >
      {Icon ? <Icon size={14} color={actionColors.color} strokeWidth={2.1} /> : null}
      <Text style={[styles.actionChipLabel, { color: actionColors.color }]}>{label}</Text>
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
  tone?: StatusTone;
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
          backgroundColor: pressed ? withAlpha(colors.text.primary, 0.03) : "transparent",
        },
      ]}
    >
      {Icon ? (
        <View
          style={[
            styles.rowIconWrap,
            {
              backgroundColor: toneColor ? withAlpha(toneColor, 0.1) : colors.surfaces.muted,
            },
          ]}
        >
          <Icon size={17} color={toneColor ?? colors.text.secondary} strokeWidth={2.1} />
        </View>
      ) : null}
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, { color: colors.text.primary }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.rowMeta, { color: colors.text.secondary }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <ChevronRight size={16} color={colors.text.tertiary} />
    </Pressable>
  );
}

export function SettingsRow({
  title,
  meta,
  icon: Icon,
  onPress,
}: {
  title: string;
  meta?: string;
  icon?: LucideIcon;
  onPress: () => void;
}) {
  return (
    <RowLink {...(Icon ? { icon: Icon } : {})} title={title} meta={meta ?? ""} onPress={onPress} />
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
  return <FilterPill label={label} selected={selected} onPress={onPress} />;
}

export function FilterPill({
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
        styles.filterPill,
        {
          backgroundColor: selected ? colors.surfaces.default : colors.surfaces.muted,
          borderColor: selected ? withAlpha(colors.accent.primary, 0.35) : colors.border.soft,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.filterPillLabel,
          { color: selected ? colors.text.primary : colors.text.secondary },
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
          backgroundColor: colors.surfaces.default,
          borderColor: colors.border.soft,
        },
      ]}
    >
      {Icon ? (
        <Icon size={18} color={colors.text.tertiary} strokeWidth={2.1} style={styles.searchIcon} />
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text.tertiary}
        style={[styles.searchInput, { color: colors.text.primary }]}
      />
    </View>
  );
}

export function FormField(props: TextInputProps) {
  const { colors } = useTheme();

  return (
    <TextInput
      placeholderTextColor={colors.text.tertiary}
      style={[
        styles.formField,
        {
          backgroundColor: colors.surfaces.muted,
          borderColor: colors.border.soft,
          color: colors.text.primary,
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
          backgroundColor: colors.surfaces.default,
          borderColor: colors.border.soft,
        },
      ]}
    >
      <Text style={[styles.emptyTitle, { color: colors.text.primary }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: colors.text.secondary }]}>{body}</Text>
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
  tone?: StatusTone;
}) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <View
      style={[
        styles.noticeBanner,
        {
          backgroundColor: withAlpha(toneColor, 0.1),
          borderColor: withAlpha(toneColor, 0.18),
        },
      ]}
    >
      <Text style={[styles.noticeTitle, { color: toneColor }]}>{title}</Text>
      {body ? (
        <Text style={[styles.noticeBody, { color: colors.text.secondary }]}>{body}</Text>
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
            { backgroundColor: colors.surfaces.default, borderColor: colors.border.soft },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  backdropBase: {
    ...StyleSheet.absoluteFillObject,
  },
  backdropOrbLarge: {
    position: "absolute",
    width: 280,
    height: 280,
    borderRadius: 140,
    top: -48,
    right: -96,
  },
  backdropOrbSmall: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 90,
    top: 180,
    left: -80,
  },
  headerShell: {
    marginBottom: 20,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  headerCopy: {
    flex: 1,
    minWidth: 180,
  },
  headerEyebrow: {
    ...Typography.roles.micro,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  headerTitle: {
    ...Typography.roles.titleLg,
  },
  headerSubtitle: {
    ...Typography.roles.meta,
    marginTop: 4,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  panel: {
    borderRadius: Radius.panel,
    borderWidth: 1,
  },
  panelPadded: {
    padding: 16,
  },
  sectionCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 16,
  },
  sectionCardCopy: {
    flex: 1,
  },
  sectionCardTitle: {
    ...Typography.roles.bodyStrong,
  },
  sectionCardMeta: {
    ...Typography.roles.meta,
    marginTop: 3,
  },
  sectionTitle: {
    ...Typography.roles.micro,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    borderWidth: 1,
    gap: 6,
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  badgeLabel: {
    ...Typography.roles.micro,
    textTransform: "none",
  },
  utilityCard: {
    flex: 1,
    minHeight: 84,
    padding: 14,
    borderRadius: Radius.card,
    borderWidth: 1,
    justifyContent: "space-between",
  },
  utilityCardLabel: {
    ...Typography.roles.meta,
  },
  utilityCardValue: {
    ...Typography.roles.titleMd,
    marginTop: 10,
  },
  utilityMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  utilityCardMeta: {
    ...Typography.roles.micro,
  },
  inlineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  iconButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  iconButtonLabel: {
    ...Typography.roles.meta,
    fontFamily: Typography.fonts.uiMedium,
  },
  actionChip: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  actionChipLabel: {
    ...Typography.roles.meta,
    fontFamily: Typography.fonts.uiMedium,
  },
  rowLink: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
  },
  rowIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    ...Typography.roles.bodyStrong,
  },
  rowMeta: {
    ...Typography.roles.meta,
    marginTop: 2,
  },
  filterPill: {
    minHeight: 34,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    justifyContent: "center",
  },
  filterPillLabel: {
    ...Typography.roles.meta,
    fontFamily: Typography.fonts.uiMedium,
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  searchIcon: {
    marginRight: 10,
  },
  searchInput: {
    ...Typography.roles.body,
    flex: 1,
  },
  formField: {
    minHeight: 48,
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingHorizontal: 14,
    ...Typography.roles.body,
  },
  emptyState: {
    padding: 20,
    borderRadius: Radius.panel,
    borderWidth: 1,
    alignItems: "flex-start",
  },
  emptyTitle: {
    ...Typography.roles.titleMd,
    marginBottom: 8,
  },
  emptyBody: {
    ...Typography.roles.body,
    marginBottom: 16,
  },
  emptyAction: {
    width: "100%",
  },
  noticeBanner: {
    padding: 16,
    borderRadius: Radius.card,
    borderWidth: 1,
    marginTop: 16,
  },
  noticeTitle: {
    ...Typography.roles.bodyStrong,
    marginBottom: 4,
  },
  noticeBody: {
    ...Typography.roles.meta,
  },
  skeletonContainer: {
    gap: 12,
  },
  skeletonRow: {
    height: 74,
    borderRadius: Radius.card,
    borderWidth: 1,
  },
});
