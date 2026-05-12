import React, { type ReactNode, useEffect, useState } from "react";
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { ChevronRight } from "lucide-react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Radius, withAlpha } from "./system";
import { useTheme, type ThemeColors } from "./ThemeContext";
import { Typography } from "./tokens";
import type { ActionTone, StatusTone } from "./roles";
import { ExpoText } from "./ExpoText";
import { enterRow, enterSection, enterSubtle, exitSubtle, layoutTransition } from "./motion";

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
        backgroundColor: withAlpha(colors.status.danger, 0.08),
        borderColor: withAlpha(colors.status.danger, 0.2),
        color: colors.status.danger,
      };
    case "quiet":
      return {
        backgroundColor: "transparent",
        borderColor: colors.border.soft,
        color: colors.text.secondary,
      };
    case "neutral":
    default:
      return {
        backgroundColor: colors.bg.canvas,
        borderColor: colors.border.soft,
        color: colors.text.primary,
      };
  }
}

export function ScreenBackdrop() {
  const { colors } = useTheme();

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.backdropBase, { backgroundColor: colors.bg.app }]} />
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
    <Animated.View
      style={[
        styles.headerShell,
        sticky && {
          backgroundColor: withAlpha(colors.bg.app, 0.96),
          borderBottomColor: colors.border.soft,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}
      entering={enterSection()}
      layout={layoutTransition}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          {eyebrow ? (
            <ExpoText style={[styles.headerEyebrow, { color: colors.text.tertiary }]}>
              {eyebrow}
            </ExpoText>
          ) : null}
          <ExpoText style={[styles.headerTitle, { color: colors.text.primary }]}>{title}</ExpoText>
          {subtitle ? (
            <ExpoText
              style={[styles.headerSubtitle, { color: colors.text.secondary }]}
              numberOfLines={2}
            >
              {subtitle}
            </ExpoText>
          ) : null}
        </View>
        {actions ? <View style={styles.headerActions}>{actions}</View> : null}
      </View>
    </Animated.View>
  );
}

export function Panel({
  children,
  style,
  padded = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <Animated.View
      style={[
        styles.panel,
        {
          backgroundColor: colors.bg.canvas,
          borderColor: colors.border.soft,
        },
        padded && styles.panelPadded,
        style,
      ]}
      layout={layoutTransition}
    >
      {children}
    </Animated.View>
  );
}

export function InsetGroup({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View entering={enterSubtle()} exiting={exitSubtle} layout={layoutTransition}>
      <Panel padded={false} style={[styles.insetGroup, style]}>
        {children}
      </Panel>
    </Animated.View>
  );
}

export function InsetRow({
  title,
  meta,
  trailing,
  onPress,
  icon: Icon,
  tone,
  last = false,
}: {
  title: string;
  meta?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  icon?: LucideIcon;
  tone?: StatusTone;
  last?: boolean;
}) {
  const { colors } = useTheme();
  const toneColor = tone ? resolveToneColor(colors, tone) : colors.accent.primary;
  const content = (
    <View
      style={[
        styles.insetRow,
        {
          borderBottomColor: last ? "transparent" : colors.border.soft,
        },
      ]}
    >
      {Icon ? (
        <View style={[styles.rowIconWrap, { backgroundColor: withAlpha(toneColor, 0.1) }]}>
          <Icon size={17} color={toneColor} strokeWidth={2.1} />
        </View>
      ) : null}
      <View style={styles.rowCopy}>
        <ExpoText style={[styles.rowTitle, { color: colors.text.primary }]} numberOfLines={1}>
          {title}
        </ExpoText>
        {meta ? (
          <ExpoText style={[styles.rowMeta, { color: colors.text.secondary }]} numberOfLines={2}>
            {meta}
          </ExpoText>
        ) : null}
      </View>
      {trailing ?? (onPress ? <ChevronRight size={16} color={colors.text.tertiary} /> : null)}
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          backgroundColor: pressed ? withAlpha(colors.text.primary, 0.03) : "transparent",
        },
      ]}
    >
      {content}
    </Pressable>
  );
}

export function DetailRow({
  label,
  value,
  tone,
  last = false,
  mono = false,
  selectable = true,
}: {
  label: string;
  value: string;
  tone?: StatusTone;
  last?: boolean;
  mono?: boolean;
  selectable?: boolean;
}) {
  const { colors } = useTheme();
  const toneColor = tone ? resolveToneColor(colors, tone) : colors.text.primary;

  return (
    <View
      style={[
        styles.detailRow,
        {
          borderBottomColor: last ? "transparent" : colors.border.soft,
        },
      ]}
    >
      <ExpoText style={[styles.detailLabel, { color: colors.text.tertiary }]}>{label}</ExpoText>
      <ExpoText
        selectable={selectable}
        style={[styles.detailValue, { color: toneColor }, mono ? Typography.roles.monoMeta : null]}
      >
        {value}
      </ExpoText>
    </View>
  );
}

export function ActionRow({
  title,
  tone = "accent",
  icon: Icon,
  onPress,
  disabled = false,
  last = false,
}: {
  title: string;
  tone?: StatusTone;
  icon?: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  last?: boolean;
}) {
  const { colors } = useTheme();
  const toneColor = resolveToneColor(colors, tone);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionRow,
        {
          borderBottomColor: last ? "transparent" : colors.border.soft,
          opacity: disabled ? 0.5 : pressed ? 0.68 : 1,
        },
      ]}
    >
      {Icon ? <Icon size={18} color={toneColor} strokeWidth={2.1} /> : null}
      <ExpoText style={[styles.actionRowLabel, { color: toneColor }]}>{title}</ExpoText>
    </Pressable>
  );
}

export function SectionFooter({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.sectionFooter, style]}>
      <ExpoText style={[styles.sectionFooterText, { color: colors.text.tertiary }]}>
        {children}
      </ExpoText>
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
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Panel {...(style ? { style } : {})}>
      <View style={styles.sectionCardHeader}>
        <View style={styles.sectionCardCopy}>
          <ExpoText style={[styles.sectionCardTitle, { color: colors.text.primary }]}>
            {title}
          </ExpoText>
          {meta ? (
            <ExpoText style={[styles.sectionCardMeta, { color: colors.text.secondary }]}>
              {meta}
            </ExpoText>
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
  style?: StyleProp<ViewStyle>;
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
      <ExpoText style={[styles.utilityCardLabel, { color: colors.text.secondary }]}>
        {label}
      </ExpoText>
      <ExpoText style={[styles.utilityCardValue, { color: colors.text.primary }]}>
        {String(value)}
      </ExpoText>
      {meta ? (
        <View style={styles.utilityMetaRow}>
          <View style={[styles.inlineDot, { backgroundColor: toneColor }]} />
          <ExpoText style={[styles.utilityCardMeta, { color: colors.text.tertiary }]}>
            {meta}
          </ExpoText>
        </View>
      ) : null}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <ExpoText style={[styles.sectionTitle, { color: colors.text.tertiary }]}>{children}</ExpoText>
  );
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
      <ExpoText style={[styles.badgeLabel, { color: toneColor }]}>{label}</ExpoText>
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
  style?: StyleProp<ViewStyle>;
}) {
  return <UtilityCard label={label} value={value} tone={tone} {...(style ? { style } : {})} />;
}

export function MetricRail({
  items,
  style,
}: {
  items: ReadonlyArray<{ label: string; value: string | number }>;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.metricRail,
        {
          backgroundColor: colors.bg.canvas,
          borderColor: colors.border.soft,
        },
        style,
      ]}
    >
      {items.map((item, index) => (
        <View
          key={item.label}
          style={[
            styles.metricRailCell,
            index > 0 && {
              borderLeftWidth: StyleSheet.hairlineWidth,
              borderLeftColor: colors.border.soft,
            },
          ]}
        >
          <ExpoText
            numberOfLines={1}
            style={[styles.metricRailValue, { color: colors.text.primary }]}
          >
            {String(item.value)}
          </ExpoText>
          <ExpoText style={[styles.metricRailLabel, { color: colors.text.secondary }]}>
            {item.label}
          </ExpoText>
        </View>
      ))}
    </View>
  );
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
  style?: StyleProp<ViewStyle>;
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
      <ExpoText style={[styles.iconButtonLabel, { color: actionColors.color }]}>{label}</ExpoText>
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
      <ExpoText style={[styles.actionChipLabel, { color: actionColors.color }]}>{label}</ExpoText>
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
  return (
    <InsetRow
      {...(Icon ? { icon: Icon } : {})}
      title={title}
      meta={meta}
      {...(tone ? { tone } : {})}
      onPress={onPress}
    />
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

export function SegmentedControl({
  options,
  selectedKey,
  onSelect,
}: {
  options: ReadonlyArray<{ key: string; label: string }>;
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  const { colors } = useTheme();
  const segmentGap = 4;
  const horizontalInset = 6;
  const [trackWidth, setTrackWidth] = useState(0);
  const selectedOffset = useSharedValue(0);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.key === selectedKey),
  );
  const segmentWidth =
    trackWidth > 0
      ? (trackWidth - horizontalInset - Math.max(options.length - 1, 0) * segmentGap) /
        Math.max(options.length, 1)
      : 0;

  useEffect(() => {
    selectedOffset.value = withTiming(selectedIndex * (segmentWidth + segmentGap), {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [segmentWidth, selectedIndex, selectedOffset]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: selectedOffset.value }],
  }));

  return (
    <Animated.View
      style={[
        styles.segmentedControl,
        {
          backgroundColor: colors.bg.canvas,
          borderColor: colors.border.soft,
        },
      ]}
      entering={enterSubtle()}
      layout={layoutTransition}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.segmentedIndicator,
            {
              backgroundColor: colors.accent.primary,
              width: segmentWidth,
            },
            indicatorStyle,
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.key === selectedKey;
        return (
          <Pressable
            key={option.key}
            onPress={() => onSelect(option.key)}
            style={({ pressed }) => [
              styles.segmentedItem,
              {
                backgroundColor: "transparent",
                borderColor: "transparent",
                opacity: pressed ? 0.76 : 1,
              },
            ]}
          >
            <ExpoText
              style={[
                styles.segmentedItemLabel,
                { color: selected ? colors.text.inverse : colors.text.secondary },
              ]}
            >
              {option.label}
            </ExpoText>
          </Pressable>
        );
      })}
    </Animated.View>
  );
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
          backgroundColor: selected ? withAlpha(colors.accent.primary, 0.1) : "transparent",
          borderColor: selected ? colors.accent.primary : colors.border.soft,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <ExpoText
        style={[
          styles.filterPillLabel,
          { color: selected ? colors.text.primary : colors.text.secondary },
        ]}
      >
        {label}
      </ExpoText>
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
    <Animated.View
      style={[
        styles.searchField,
        {
          backgroundColor: colors.bg.canvas,
          borderColor: colors.border.soft,
        },
      ]}
      layout={layoutTransition}
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
    </Animated.View>
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
          backgroundColor: colors.bg.canvas,
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
    <Animated.View
      style={[
        styles.emptyState,
        {
          backgroundColor: colors.bg.canvas,
          borderColor: colors.border.soft,
        },
      ]}
      entering={enterSection(30)}
      exiting={exitSubtle}
      layout={layoutTransition}
    >
      <ExpoText style={[styles.emptyTitle, { color: colors.text.primary }]}>{title}</ExpoText>
      <ExpoText style={[styles.emptyBody, { color: colors.text.secondary }]}>{body}</ExpoText>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </Animated.View>
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
    <Animated.View
      style={[
        styles.noticeBanner,
        {
          backgroundColor: withAlpha(toneColor, 0.1),
          borderColor: withAlpha(toneColor, 0.18),
        },
      ]}
      entering={enterSection(20)}
      exiting={exitSubtle}
      layout={layoutTransition}
    >
      <ExpoText style={[styles.noticeTitle, { color: toneColor }]}>{title}</ExpoText>
      {body ? (
        <ExpoText style={[styles.noticeBody, { color: colors.text.secondary }]}>{body}</ExpoText>
      ) : null}
    </Animated.View>
  );
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  const { colors } = useTheme();

  return (
    <Animated.View
      style={styles.skeletonContainer}
      entering={enterSubtle()}
      layout={layoutTransition}
    >
      {Array.from({ length: rows }, (_, rowIndex) => `skeleton-row-${rowIndex}`).map(
        (rowId, index) => (
          <Animated.View
            key={rowId}
            style={[
              styles.skeletonRow,
              { backgroundColor: colors.surfaces.default, borderColor: colors.border.soft },
            ]}
            entering={enterRow(index)}
            layout={layoutTransition}
          />
        ),
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdropBase: {
    ...StyleSheet.absoluteFillObject,
  },
  headerShell: {
    marginBottom: 24,
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
    letterSpacing: 0.72,
    marginBottom: 8,
  },
  headerTitle: {
    ...Typography.roles.displayLg,
  },
  headerSubtitle: {
    ...Typography.roles.meta,
    marginTop: 6,
    maxWidth: 360,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  panel: {
    borderRadius: Radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
  },
  insetGroup: {
    overflow: "hidden",
  },
  panelPadded: {
    padding: 18,
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
    letterSpacing: 0.72,
  },
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radius.pill,
    borderWidth: 1,
    gap: 6,
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 0,
  },
  badgeLabel: {
    ...Typography.roles.micro,
    textTransform: "none",
  },
  utilityCard: {
    flex: 1,
    minHeight: 74,
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: Radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "flex-start",
  },
  utilityCardLabel: {
    ...Typography.roles.meta,
  },
  utilityCardValue: {
    ...Typography.roles.titleMd,
    marginTop: 8,
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
    borderRadius: 0,
  },
  metricRail: {
    flexDirection: "row",
    borderRadius: Radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  metricRailCell: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 14,
    gap: 4,
  },
  metricRailValue: {
    ...Typography.roles.titleMd,
    fontVariant: ["tabular-nums"],
  },
  metricRailLabel: {
    ...Typography.roles.micro,
    textTransform: "uppercase",
  },
  iconButton: {
    minHeight: 38,
    paddingHorizontal: 11,
    borderRadius: Radius.input,
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
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: Radius.input,
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
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 12,
  },
  rowIconWrap: {
    width: 36,
    height: 36,
    borderRadius: Radius.input,
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
  insetRow: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailRow: {
    paddingHorizontal: 18,
    paddingVertical: 13,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailLabel: {
    ...Typography.roles.micro,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  detailValue: {
    ...Typography.roles.body,
  },
  actionRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionRowLabel: {
    ...Typography.roles.bodyStrong,
  },
  sectionFooter: {
    paddingHorizontal: 6,
    paddingTop: 8,
  },
  sectionFooterText: {
    ...Typography.roles.meta,
  },
  filterPill: {
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.input,
    borderWidth: 1,
    justifyContent: "center",
  },
  filterPillLabel: {
    ...Typography.roles.meta,
    fontFamily: Typography.fonts.uiMedium,
  },
  segmentedControl: {
    minHeight: 42,
    borderRadius: Radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    flexDirection: "row",
    gap: 4,
    overflow: "hidden",
    position: "relative",
  },
  segmentedIndicator: {
    position: "absolute",
    top: 3,
    bottom: 3,
    left: 3,
    borderRadius: Radius.sm,
  },
  segmentedItem: {
    flex: 1,
    minHeight: 34,
    borderRadius: Radius.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    zIndex: 1,
  },
  segmentedItemLabel: {
    ...Typography.roles.meta,
    fontFamily: Typography.fonts.uiMedium,
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: Radius.input,
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
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 14,
    ...Typography.roles.body,
  },
  emptyState: {
    padding: 18,
    borderRadius: Radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
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
    borderRadius: Radius.panel,
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
    height: 68,
    borderRadius: Radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
