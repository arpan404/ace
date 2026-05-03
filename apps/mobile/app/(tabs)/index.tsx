import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LoaderCircle, Search } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import {
  EmptyState,
  IconButton,
  MetricCard,
  Panel,
  ScreenBackdrop,
  ScreenHeader,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import {
  formatTimeAgo,
  type MobileThreadSummary,
  useAggregatedOrchestration,
} from "../../src/orchestration/mobileData";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "queued", label: "Queued" },
  { key: "input", label: "Input" },
  { key: "review", label: "Review" },
  { key: "waiting", label: "Ready" },
  { key: "completed", label: "Done" },
  { key: "error", label: "Errors" },
] as const;

type ThreadFilter = (typeof FILTERS)[number]["key"];

export default function ThreadsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { threads, refresh, loading, error } = useAggregatedOrchestration();
  const [activeFilter, setActiveFilter] = useState<ThreadFilter>("all");

  const filteredThreads = useMemo(() => {
    if (activeFilter === "all") {
      return threads;
    }
    return threads.filter((entry) => entry.status.bucket === activeFilter);
  }, [activeFilter, threads]);

  const queueCount = threads.filter((entry) => entry.status.bucket === "queued").length;
  const attentionCount = threads.filter(
    (entry) => entry.status.bucket === "input" || entry.status.bucket === "review",
  ).length;
  const streamingCount = threads.filter((entry) => entry.status.bucket === "live").length;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <ScreenHeader
          eyebrow="ace"
          title="Threads"
          subtitle="Monitor every agent thread across connected hosts, from live runs to review-ready work."
          action={
            <View style={styles.headerActions}>
              <IconButton icon={Search} label="Find" onPress={() => router.push("/search")} />
              <StatusBadge label={`${threads.length} threads`} tone="success" />
            </View>
          }
        />

        <View style={styles.metricRow}>
          <MetricCard label="Streaming" value={streamingCount} tone="success" />
          <MetricCard label="Queued" value={queueCount} tone="warning" />
          <MetricCard label="Attention" value={attentionCount} tone="accent" />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterStrip}
        >
          {FILTERS.map((filter) => {
            const selected = filter.key === activeFilter;
            return (
              <Pressable
                key={filter.key}
                onPress={() => setActiveFilter(filter.key)}
                style={[
                  styles.filterChip,
                  {
                    backgroundColor: selected ? colors.surface : colors.surfaceSecondary,
                    borderColor: selected ? withAlpha(colors.primary, 0.44) : colors.elevatedBorder,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.filterLabel,
                    { color: selected ? colors.foreground : colors.secondaryLabel },
                  ]}
                >
                  {filter.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.sectionHeader}>
          <SectionTitle>Execution Feed</SectionTitle>
          <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
            {filteredThreads.length} visible
          </Text>
        </View>

        {filteredThreads.length === 0 ? (
          <EmptyState
            title="No active threads"
            body="Threads from connected hosts will appear here once projects sync or agent runs start."
          />
        ) : (
          <Panel padded={false} style={styles.listShell}>
            {filteredThreads.map((entry, index) => (
              <ThreadRow
                key={`${entry.hostId}-${entry.thread.id}`}
                entry={entry}
                index={index}
                total={filteredThreads.length}
                onPress={() =>
                  router.push({
                    pathname: "/thread/[threadId]",
                    params: { threadId: entry.thread.id, hostId: entry.hostId },
                  })
                }
              />
            ))}
          </Panel>
        )}

        {error ? <Text style={[styles.footerError, { color: colors.red }]}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}

function ThreadRow({
  entry,
  index,
  total,
  onPress,
}: {
  entry: MobileThreadSummary;
  index: number;
  total: number;
  onPress: () => void;
}) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.threadRow,
        {
          backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
        },
      ]}
    >
      <View
        style={[
          styles.threadLead,
          {
            backgroundColor: withAlpha(
              entry.status.tone === "success"
                ? colors.green
                : entry.status.tone === "warning"
                  ? colors.orange
                  : entry.status.tone === "danger"
                    ? colors.red
                    : entry.status.tone === "accent"
                      ? colors.primary
                      : colors.muted,
              0.15,
            ),
          },
        ]}
      >
        <LoaderCircle
          size={18}
          color={
            entry.status.tone === "success"
              ? colors.green
              : entry.status.tone === "warning"
                ? colors.orange
                : entry.status.tone === "danger"
                  ? colors.red
                  : entry.status.tone === "accent"
                    ? colors.primary
                    : colors.muted
          }
          strokeWidth={2.2}
        />
      </View>
      <View style={styles.threadCopy}>
        <View style={styles.threadHeader}>
          <Text style={[styles.threadTitle, { color: colors.foreground }]} numberOfLines={1}>
            {entry.thread.title}
          </Text>
          <StatusBadge label={entry.status.label} tone={entry.status.tone} />
        </View>
        <Text style={[styles.threadMeta, { color: colors.secondaryLabel }]} numberOfLines={1}>
          {entry.projectTitle} · {entry.hostName}
        </Text>
        <Text style={[styles.threadPreview, { color: colors.tertiaryLabel }]} numberOfLines={2}>
          {entry.preview}
        </Text>
        <View style={styles.threadFooter}>
          <Text style={[styles.threadTime, { color: colors.muted }]}>
            {formatTimeAgo(entry.lastActivityAt)}
          </Text>
          {entry.attentionActivity ? (
            <Text
              style={[styles.threadFootnote, { color: colors.secondaryLabel }]}
              numberOfLines={1}
            >
              {entry.attentionActivity.summary}
            </Text>
          ) : null}
        </View>
      </View>
      {index < total - 1 ? (
        <View style={[styles.separator, { backgroundColor: colors.separator }]} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerActions: {
    alignItems: "flex-end",
    gap: 8,
  },
  metricRow: {
    marginTop: 22,
    flexDirection: "row",
    gap: 10,
  },
  filterStrip: {
    gap: 10,
    paddingTop: 18,
  },
  filterChip: {
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  filterLabel: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
  sectionHeader: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  listShell: {
    overflow: "hidden",
  },
  threadRow: {
    minHeight: 126,
    paddingHorizontal: 18,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  threadLead: {
    width: 44,
    height: 44,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  threadCopy: {
    flex: 1,
  },
  threadHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  threadTitle: {
    flex: 1,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "800",
    letterSpacing: -0.55,
  },
  threadMeta: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  threadPreview: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
  },
  threadFooter: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  threadTime: {
    fontSize: 12,
    fontWeight: "700",
  },
  threadFootnote: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 18,
    right: 18,
    height: StyleSheet.hairlineWidth,
  },
  footerError: {
    marginTop: 14,
    fontSize: 12,
    lineHeight: 18,
  },
});
