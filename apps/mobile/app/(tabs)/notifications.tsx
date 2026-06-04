import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AlertTriangle,
  CheckCircle2,
  GitCompare,
  MessageCircleQuestion,
} from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { ExpoText } from "../../src/design/ExpoText";
import { Layout, withAlpha } from "../../src/design/system";
import { Typography } from "../../src/design/tokens";
import {
  EmptyState,
  IconButton,
  InlineStatusDot,
  ListSkeleton,
  NoticeBanner,
  ScreenHeaderV2,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import {
  formatTimeAgo,
  type MobileThreadSummary,
  useAggregatedOrchestration,
} from "../../src/orchestration/mobileData";

type AttentionKind = "error" | "input" | "review";

interface AttentionItem {
  readonly id: string;
  readonly entry: MobileThreadSummary;
  readonly kind: AttentionKind;
  readonly title: string;
  readonly detail: string;
  readonly cta: string;
}

function attentionKind(entry: MobileThreadSummary): AttentionKind | null {
  if (entry.status.bucket === "error") {
    return "error";
  }
  if (entry.status.bucket === "input") {
    return "input";
  }
  if (entry.status.bucket === "review") {
    return "review";
  }
  return null;
}

function attentionCopy(entry: MobileThreadSummary, kind: AttentionKind) {
  if (kind === "error") {
    return {
      title: "Recover stopped session",
      detail: entry.attentionActivity?.summary ?? entry.preview,
      cta: "Open recovery",
    };
  }
  if (kind === "input") {
    return {
      title: "Answer agent question",
      detail: entry.attentionActivity?.summary ?? entry.preview,
      cta: "Respond",
    };
  }
  return {
    title: "Review changed files",
    detail: entry.attentionActivity?.summary ?? entry.preview,
    cta: "Review diff",
  };
}

function buildAttentionItems(threads: ReadonlyArray<MobileThreadSummary>): AttentionItem[] {
  return threads.flatMap((entry) => {
    const kind = attentionKind(entry);
    if (!kind) {
      return [];
    }
    return [
      {
        id: `${entry.hostId}-${entry.thread.id}-${kind}`,
        entry,
        kind,
        ...attentionCopy(entry, kind),
      },
    ];
  });
}

function kindTone(kind: AttentionKind): "accent" | "danger" | "warning" {
  if (kind === "error") {
    return "danger";
  }
  if (kind === "input") {
    return "warning";
  }
  return "accent";
}

function AttentionRow({ item, onPress }: { item: AttentionItem; onPress: () => void }) {
  const { colors } = useTheme();
  const tone = kindTone(item.kind);
  const toneColor =
    tone === "danger"
      ? colors.status.danger
      : tone === "warning"
        ? colors.status.warning
        : colors.accent.primary;
  const Icon =
    item.kind === "error"
      ? AlertTriangle
      : item.kind === "input"
        ? MessageCircleQuestion
        : GitCompare;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.attentionRow,
        {
          backgroundColor: pressed ? withAlpha(toneColor, 0.08) : colors.bg.canvas,
          borderColor: withAlpha(toneColor, 0.22),
        },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: withAlpha(toneColor, 0.13) }]}>
        <Icon size={20} color={toneColor} strokeWidth={2.3} />
      </View>
      <View style={styles.attentionCopy}>
        <View style={styles.rowTop}>
          <ExpoText style={[styles.actionTitle, { color: colors.text.primary }]} numberOfLines={1}>
            {item.title}
          </ExpoText>
          <StatusBadge label={item.entry.status.label} tone={item.entry.status.tone} />
        </View>
        <ExpoText style={[styles.threadTitle, { color: colors.text.primary }]} numberOfLines={1}>
          {item.entry.thread.title}
        </ExpoText>
        <ExpoText style={[styles.detail, { color: colors.text.secondary }]} numberOfLines={2}>
          {item.detail}
        </ExpoText>
        <View style={styles.metaRow}>
          <InlineStatusDot tone={item.entry.status.tone} />
          <ExpoText style={[styles.meta, { color: colors.text.tertiary }]} numberOfLines={1}>
            {item.entry.projectTitle} · {item.entry.hostName}
          </ExpoText>
          <ExpoText style={[styles.time, { color: colors.text.tertiary }]}>
            {formatTimeAgo(item.entry.lastActivityAt)}
          </ExpoText>
        </View>
      </View>
      <View style={[styles.ctaPill, { backgroundColor: withAlpha(toneColor, 0.12) }]}>
        <ExpoText style={[styles.ctaText, { color: toneColor }]}>{item.cta}</ExpoText>
      </View>
    </Pressable>
  );
}

export default function AttentionInboxScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { threads, activeThreads, refresh, loading, error, connectedHostCount } =
    useAggregatedOrchestration();
  const [refreshing, setRefreshing] = useState(false);

  const attentionItems = useMemo(() => buildAttentionItems(threads), [threads]);
  const liveCount = activeThreads.filter((entry) => entry.status.bucket === "live").length;
  const queuedCount = threads.filter((entry) => entry.status.bucket === "queued").length;

  const refreshInbox = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const openThreadAction = useCallback(
    (item: AttentionItem) => {
      router.push({
        pathname: "/thread/[threadId]",
        params: {
          threadId: item.entry.thread.id,
          hostId: item.entry.hostId,
          panel: item.kind === "review" ? "review" : "actions",
        },
      });
    },
    [router],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.bg.app }]}>
      <FlatList
        data={attentionItems}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={loading || refreshing}
            onRefresh={() => void refreshInbox()}
          />
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 24,
            paddingHorizontal: Layout.pagePadding,
            paddingBottom: insets.bottom + 120,
          },
        ]}
        ListHeaderComponent={
          <View>
            <ScreenHeaderV2
              title="Attention"
              subtitle="UNBLOCK RUNNING AGENTS"
              actions={
                <IconButton icon={CheckCircle2} label="Threads" onPress={() => router.push("/")} />
              }
            />
            <View style={styles.summaryGrid}>
              <View
                style={[
                  styles.summaryTile,
                  { backgroundColor: colors.bg.canvas, borderColor: colors.border.soft },
                ]}
              >
                <ExpoText style={[styles.summaryValue, { color: colors.text.primary }]}>
                  {attentionItems.length}
                </ExpoText>
                <ExpoText style={[styles.summaryLabel, { color: colors.text.tertiary }]}>
                  Need action
                </ExpoText>
              </View>
              <View
                style={[
                  styles.summaryTile,
                  { backgroundColor: colors.bg.canvas, borderColor: colors.border.soft },
                ]}
              >
                <ExpoText style={[styles.summaryValue, { color: colors.text.primary }]}>
                  {liveCount}
                </ExpoText>
                <ExpoText style={[styles.summaryLabel, { color: colors.text.tertiary }]}>
                  Streaming
                </ExpoText>
              </View>
              <View
                style={[
                  styles.summaryTile,
                  { backgroundColor: colors.bg.canvas, borderColor: colors.border.soft },
                ]}
              >
                <ExpoText style={[styles.summaryValue, { color: colors.text.primary }]}>
                  {queuedCount}
                </ExpoText>
                <ExpoText style={[styles.summaryLabel, { color: colors.text.tertiary }]}>
                  Queued
                </ExpoText>
              </View>
            </View>
            {error ? <NoticeBanner tone="danger" title="Sync issue" body={error} /> : null}
            <View style={styles.sectionHeader}>
              <SectionTitle>Action Queue</SectionTitle>
              <StatusBadge
                label={`${connectedHostCount} host${connectedHostCount === 1 ? "" : "s"} online`}
                tone={connectedHostCount > 0 ? "success" : "muted"}
              />
            </View>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ListSkeleton rows={4} />
          ) : (
            <EmptyState
              title="Nothing needs you"
              body="Approvals, user questions, recoverable errors, and diff-ready turns will land here."
            />
          )
        }
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item }) => (
          <AttentionRow item={item} onPress={() => openThreadAction(item)} />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    gap: 0,
  },
  summaryGrid: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 22,
  },
  summaryTile: {
    flex: 1,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  summaryValue: {
    ...Typography.roles.titleLg,
  },
  summaryLabel: {
    ...Typography.roles.micro,
    marginTop: 4,
    textTransform: "uppercase",
  },
  sectionHeader: {
    marginTop: 4,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  attentionRow: {
    minHeight: 148,
    borderWidth: 1,
    padding: 16,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  iconWrap: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  attentionCopy: {
    flex: 1,
    minWidth: 0,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  actionTitle: {
    ...Typography.roles.bodyStrong,
    flex: 1,
  },
  threadTitle: {
    ...Typography.roles.titleMd,
    marginTop: 8,
  },
  detail: {
    ...Typography.roles.body,
    marginTop: 7,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
  },
  meta: {
    ...Typography.roles.meta,
    flex: 1,
  },
  time: {
    ...Typography.roles.micro,
  },
  ctaPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  ctaText: {
    ...Typography.roles.micro,
    textTransform: "uppercase",
  },
});
