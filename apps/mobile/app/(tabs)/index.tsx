import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LoaderCircle, Search, Settings2 } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import {
  ChoiceChip,
  EmptyState,
  IconButton,
  ListSkeleton,
  MetricCard,
  NoticeBanner,
  Panel,
  ScreenBackdrop,
  GlassScreenHeader,
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
      <GlassScreenHeader
        title="Threads"
        action={
          <View style={styles.headerActions}>
            <IconButton icon={Search} label="Search" onPress={() => router.push("/search")} />
            <IconButton icon={Settings2} label="Settings" onPress={() => router.push("/profile")} />
            <StatusBadge label={`${threads.length}`} tone="success" />
          </View>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 80,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <View style={styles.metricRow}>
          <MetricCard label="Streaming" value={streamingCount} tone="success" />
          <MetricCard label="Queued" value={queueCount} tone="warning" />
          <MetricCard label="Attention" value={attentionCount} tone="accent" />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterStrip}
          style={styles.filterStripScroll}
        >
          {FILTERS.map((filter) => {
            return (
              <ChoiceChip
                key={filter.key}
                label={filter.label}
                selected={filter.key === activeFilter}
                onPress={() => setActiveFilter(filter.key)}
              />
            );
          })}
        </ScrollView>

        <View style={styles.sectionHeader}>
          <SectionTitle>Recent Activity</SectionTitle>
          <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
            {filteredThreads.length} threads
          </Text>
        </View>

        {loading ? (
          <ListSkeleton rows={5} />
        ) : filteredThreads.length === 0 ? (
          <EmptyState
            title="No active threads"
            body="Threads from connected hosts will appear here once projects sync or agent runs start."
          />
        ) : (
          <View style={styles.listShell}>
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
          </View>
        )}

        {error ? (
          <NoticeBanner tone="danger" title="Unable to refresh threads" body={error} />
        ) : null}
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
          transform: [{ scale: pressed ? 0.995 : 1 }],
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
    alignItems: "center",
    gap: 8,
    flexDirection: "row",
  },
  metricRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  filterStripScroll: {
    marginBottom: 4,
  },
  filterStrip: {
    gap: 10,
  },
  sectionHeader: {
    marginTop: 20,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 12,
    fontWeight: "700",
  },
  listShell: {
    gap: 12,
  },
  threadRow: {
    minHeight: 110,
    paddingHorizontal: 18,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    borderRadius: Radius.card,
    borderWidth: 1.5,
  },
  threadLead: {
    width: 36,
    height: 36,
    borderRadius: 10,
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
    gap: 10,
  },
  threadTitle: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  threadMeta: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "500",
  },
  threadPreview: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  threadFooter: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  threadTime: {
    fontSize: 12,
    fontWeight: "500",
  },
  threadFootnote: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  separator: {
    display: "none",
  },
});
