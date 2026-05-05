import React, { type ReactNode } from "react";
import { StyleSheet, TextInput, View, Pressable, Text } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useTheme } from "../ThemeContext";
import { Typography } from "../tokens";
import { Radius, withAlpha } from "../system";

export function ComposerDock({
  value,
  onChangeText,
  placeholder,
  canSend,
  onSend,
  leadingActions,
  SendIcon,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  canSend: boolean;
  onSend: () => void;
  leadingActions?: ReactNode;
  SendIcon: LucideIcon;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.shell,
        {
          backgroundColor: colors.surfaces.default,
          borderColor: colors.border.soft,
        },
      ]}
    >
      <View style={styles.leading}>{leadingActions}</View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text.tertiary}
        style={[styles.input, { color: colors.text.primary }]}
        multiline
      />
      <Pressable
        onPress={onSend}
        disabled={!canSend}
        style={[
          styles.sendButton,
          {
            backgroundColor: canSend ? colors.accent.primary : colors.surfaces.muted,
            opacity: canSend ? 1 : 0.82,
          },
        ]}
      >
        <SendIcon
          size={16}
          color={canSend ? colors.text.inverse : colors.text.tertiary}
          strokeWidth={2.5}
        />
      </Pressable>
    </View>
  );
}

export function ComposerMetaChip({
  label,
  icon: Icon,
  onRemove,
}: {
  label: string;
  icon: LucideIcon;
  onRemove?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.metaChip,
        {
          backgroundColor: colors.accent.soft,
          borderColor: withAlpha(colors.accent.primary, 0.2),
        },
      ]}
    >
      <Icon size={13} color={colors.accent.primary} strokeWidth={2.1} />
      <Text style={[styles.metaChipLabel, { color: colors.text.primary }]} numberOfLines={1}>
        {label}
      </Text>
      {onRemove ? (
        <Pressable onPress={onRemove} style={styles.metaChipClear}>
          <Text style={[styles.metaChipClearLabel, { color: colors.text.secondary }]}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    minHeight: 54,
    borderWidth: 1,
    borderRadius: Radius.xl,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  leading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingBottom: 3,
  },
  input: {
    ...Typography.roles.body,
    flex: 1,
    minHeight: 22,
    maxHeight: 120,
    paddingTop: 4,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  metaChip: {
    minHeight: 30,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaChipLabel: {
    ...Typography.roles.meta,
    maxWidth: 180,
  },
  metaChipClear: {
    paddingLeft: 4,
  },
  metaChipClearLabel: {
    ...Typography.roles.bodyStrong,
    lineHeight: 16,
  },
});
