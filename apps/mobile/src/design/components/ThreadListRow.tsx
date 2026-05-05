import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileThreadSummary } from "../../orchestration/mobileData";
import { useTheme } from "../ThemeContext";
import { Typography } from "../tokens";
import { Layout, withAlpha } from "../system";
import { InlineStatusDot, StatusBadge } from "../primitives";

export function ThreadListRow({
  entry,
  onPress,
}: {
  entry: MobileThreadSummary;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? withAlpha(colors.text.primary, 0.03) : "transparent",
          borderBottomColor: colors.border.soft,
        },
      ]}
    >
      <View style={styles.rowTop}>
        <Text style={[styles.title, { color: colors.text.primary }]} numberOfLines={1}>
          {entry.thread.title}
        </Text>
        <StatusBadge label={entry.status.label} tone={entry.status.tone} />
      </View>
      <View style={styles.rowMeta}>
        <InlineStatusDot tone={entry.status.tone} />
        <Text style={[styles.metaText, { color: colors.text.secondary }]} numberOfLines={1}>
          {entry.projectTitle} · {entry.hostName}
        </Text>
        <Text style={[styles.timeText, { color: colors.text.tertiary }]}>
          {entry.lastActivityAt}
        </Text>
      </View>
      <Text style={[styles.preview, { color: colors.text.tertiary }]} numberOfLines={2}>
        {entry.attentionActivity?.summary ?? entry.preview}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: Layout.rowHeight,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    ...Typography.roles.bodyStrong,
    flex: 1,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  metaText: {
    ...Typography.roles.meta,
    flex: 1,
  },
  timeText: {
    ...Typography.roles.micro,
  },
  preview: {
    ...Typography.roles.meta,
    marginTop: 8,
  },
});
