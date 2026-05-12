import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { formatTimeAgo, type MobileThreadSummary } from "../../orchestration/mobileData";
import { useTheme } from "../ThemeContext";
import { Typography } from "../tokens";
import { Layout, withAlpha } from "../system";
import { InlineStatusDot, StatusBadge } from "../primitives";
import { ExpoText } from "../ExpoText";
import { enterRow, exitRow, layoutTransition } from "../motion";

export function ThreadListRow({
  entry,
  onPress,
  animationIndex = 0,
}: {
  entry: MobileThreadSummary;
  onPress: () => void;
  animationIndex?: number;
}) {
  const { colors } = useTheme();
  return (
    <Animated.View entering={enterRow(animationIndex)} exiting={exitRow} layout={layoutTransition}>
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
          <ExpoText style={[styles.title, { color: colors.text.primary }]} numberOfLines={1}>
            {entry.thread.title}
          </ExpoText>
          <StatusBadge label={entry.status.label} tone={entry.status.tone} />
        </View>
        <View style={styles.rowMeta}>
          <InlineStatusDot tone={entry.status.tone} />
          <ExpoText style={[styles.metaText, { color: colors.text.secondary }]} numberOfLines={1}>
            {entry.projectTitle} · {entry.hostName}
          </ExpoText>
          <ExpoText style={[styles.timeText, { color: colors.text.tertiary }]}>
            {formatTimeAgo(entry.lastActivityAt)}
          </ExpoText>
        </View>
        <ExpoText style={[styles.preview, { color: colors.text.tertiary }]} numberOfLines={2}>
          {entry.attentionActivity?.summary ?? entry.preview}
        </ExpoText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: Layout.rowHeight,
    paddingVertical: 16,
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
    marginTop: 10,
  },
});
