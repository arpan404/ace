import React, { useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout } from "../../src/design/system";
import {
  EmptyState,
  ListSkeleton,
  NoticeBanner,
  ScreenHeaderV2,
  SegmentedControl,
  StatusBadge,
} from "../../src/design/primitives";
import { useAggregatedOrchestration } from "../../src/orchestration/mobileData";
import { ThreadListRow } from "../../src/design/components/ThreadListRow";

const FILTERS = [
  { key: "attention", label: "Attention" },
  { key: "live", label: "Live" },
  { key: "queued", label: "Queued" },
  { key: "recent", label: "Recent" },
] as const;

type ThreadFilter = (typeof FILTERS)[number]["key"];

export default function ThreadsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { threads, refresh, loading, error } = useAggregatedOrchestration();
  const [activeFilter, setActiveFilter] = useState<ThreadFilter>("attention");

  useEffect(() => {
    if (params.filter === "live" || params.filter === "queued" || params.filter === "recent") {
      setActiveFilter(params.filter);
      return;
    }
    if (params.filter === "attention") {
      setActiveFilter("attention");
    }
  }, [params.filter]);

  const filteredThreads = useMemo(() => {
    if (activeFilter === "attention") {
      return threads.filter((entry) => ["input", "review", "error"].includes(entry.status.bucket));
    }
    if (activeFilter === "live") {
      return threads.filter((entry) => ["live", "waiting"].includes(entry.status.bucket));
    }
    if (activeFilter === "queued") {
      return threads.filter((entry) => entry.status.bucket === "queued");
    }
    return threads.filter(
      (entry) =>
        !["input", "review", "error", "live", "waiting", "queued"].includes(entry.status.bucket),
    );
  }, [activeFilter, threads]);

  const attentionCount = threads.filter(
    (entry) =>
      entry.status.bucket === "input" ||
      entry.status.bucket === "review" ||
      entry.status.bucket === "error",
  ).length;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <ScreenHeaderV2
          title="Threads"
          subtitle="MONITOR RUNNING AGENT THREADS"
          actions={
            <View style={styles.headerActions}>
              {attentionCount > 0 ? (
                <StatusBadge label={`ACTION NEEDED (${attentionCount})`} tone="danger" />
              ) : null}
            </View>
          }
        />

        <View style={{ marginBottom: 24, borderWidth: 1, borderColor: colors.border.soft }}>
          <SegmentedControl
            options={FILTERS}
            selectedKey={activeFilter}
            onSelect={(key) => setActiveFilter(key as ThreadFilter)}
          />
        </View>

        {loading ? (
          <ListSkeleton rows={5} />
        ) : filteredThreads.length === 0 ? (
          <EmptyState
            title="NO THREADS FOUND"
            body="Start an agent run from your connected workspace to see activity here."
          />
        ) : (
          <View style={styles.groupList}>
            {filteredThreads.map((entry, index) => (
              <ThreadListRow
                key={`${entry.hostId}-${entry.thread.id}`}
                entry={entry}
                animationIndex={index}
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

        {error ? <NoticeBanner tone="danger" title="NETWORK ERROR" body={error} /> : null}
      </ScrollView>
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
  groupList: {
    gap: 18,
  },
});
