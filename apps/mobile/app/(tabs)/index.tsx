import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bell, Search, SlidersHorizontal } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout } from "../../src/design/system";
import {
  ChoiceChip,
  EmptyState,
  IconButton,
  ListSkeleton,
  NoticeBanner,
  Panel,
  ScreenBackdrop,
  ScreenHeaderV2,
  SectionTitle,
} from "../../src/design/primitives";
import { useAggregatedOrchestration } from "../../src/orchestration/mobileData";
import { ThreadListRow } from "../../src/design/components/ThreadListRow";

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
  const { threads, attentionThreads, refresh, loading, error } = useAggregatedOrchestration();
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

  const groupedThreads = useMemo(() => {
    const needsAttention = filteredThreads.filter(
      (entry) => entry.status.bucket === "input" || entry.status.bucket === "review",
    );
    const active = filteredThreads.filter(
      (entry) =>
        entry.status.bucket === "live" ||
        entry.status.bucket === "queued" ||
        entry.status.bucket === "waiting",
    );
    const recent = filteredThreads.filter(
      (entry) => !needsAttention.includes(entry) && !active.includes(entry),
    );

    return [
      { title: "Needs attention", items: needsAttention },
      { title: "Active", items: active },
      { title: "Recent", items: recent },
    ].filter((group) => group.items.length > 0);
  }, [filteredThreads]);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 14,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <ScreenHeaderV2
          title="Threads"
          subtitle="Your active coding runs, queued work, and review requests."
          actions={
            <View style={styles.headerActions}>
              <IconButton
                icon={Bell}
                label={String(attentionThreads.length)}
                onPress={() => router.push("/notifications")}
              />
              <IconButton icon={Search} label="Search" onPress={() => router.push("/search")} />
              <IconButton
                icon={SlidersHorizontal}
                label="Settings"
                onPress={() => router.push("/settings")}
              />
            </View>
          }
        />

        <Panel style={styles.summaryStrip}>
          <SummaryCell label="Running" value={streamingCount} />
          <SummaryCell label="Queued" value={queueCount} />
          <SummaryCell label="Review" value={attentionCount} />
        </Panel>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterStrip}
          style={styles.filterStripScroll}
        >
          {FILTERS.map((filter) => (
            <ChoiceChip
              key={filter.key}
              label={filter.label}
              selected={filter.key === activeFilter}
              onPress={() => setActiveFilter(filter.key)}
            />
          ))}
        </ScrollView>

        {loading ? (
          <ListSkeleton rows={5} />
        ) : filteredThreads.length === 0 ? (
          <EmptyState
            title="No active threads"
            body="Threads from connected hosts will appear here once projects sync or agent runs start."
          />
        ) : (
          <View style={styles.groupList}>
            {groupedThreads.map((group) => (
              <View key={group.title} style={styles.groupSection}>
                <View style={styles.sectionHeader}>
                  <SectionTitle>{group.title}</SectionTitle>
                  <Text style={[styles.sectionMeta, { color: colors.text.tertiary }]}>
                    {group.items.length}
                  </Text>
                </View>
                <Panel style={styles.listShell}>
                  {group.items.map((entry) => (
                    <ThreadListRow
                      key={`${entry.hostId}-${entry.thread.id}`}
                      entry={entry}
                      onPress={() =>
                        router.push({
                          pathname: "/thread/[threadId]",
                          params: { threadId: entry.thread.id, hostId: entry.hostId },
                        })
                      }
                    />
                  ))}
                </Panel>
              </View>
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

function SummaryCell({ label, value }: { label: string; value: number }) {
  const { colors } = useTheme();
  return (
    <View style={styles.summaryCell}>
      <Text style={[styles.summaryValue, { color: colors.text.primary }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: colors.text.secondary }]}>{label}</Text>
    </View>
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
  summaryStrip: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  summaryCell: {
    flex: 1,
    gap: 2,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: "600",
  },
  summaryLabel: {
    fontSize: 12,
  },
  filterStripScroll: {
    marginBottom: 12,
  },
  filterStrip: {
    gap: 10,
  },
  groupList: {
    gap: 18,
  },
  groupSection: {
    gap: 0,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 11,
  },
  listShell: {
    paddingHorizontal: 16,
  },
});
