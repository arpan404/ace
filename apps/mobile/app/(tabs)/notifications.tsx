import React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BellDot,
  CircleAlert,
  FileDiff,
  MessageSquareMore,
  ShieldAlert,
} from "lucide-react-native";
import { Layout, withAlpha } from "../../src/design/system";
import { useTheme } from "../../src/design/ThemeContext";
import {
  EmptyState,
  MetricCard,
  NoticeBanner,
  Panel,
  RowLink,
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

const SECTION_META = {
  input: {
    title: "Input required",
    tone: "warning" as const,
    Icon: MessageSquareMore,
  },
  review: {
    title: "Diff ready",
    tone: "accent" as const,
    Icon: FileDiff,
  },
  error: {
    title: "Errored",
    tone: "danger" as const,
    Icon: ShieldAlert,
  },
  completed: {
    title: "Completed",
    tone: "muted" as const,
    Icon: CircleAlert,
  },
} as const;

export default function NotificationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { attentionThreads, refresh, loading, error } = useAggregatedOrchestration();

  const sections = [
    {
      key: "input" as const,
      items: attentionThreads.filter((entry) => entry.status.bucket === "input"),
    },
    {
      key: "review" as const,
      items: attentionThreads.filter((entry) => entry.status.bucket === "review"),
    },
    {
      key: "error" as const,
      items: attentionThreads.filter((entry) => entry.status.bucket === "error"),
    },
    {
      key: "completed" as const,
      items: attentionThreads.filter((entry) => entry.status.bucket === "completed"),
    },
  ].filter((section) => section.items.length > 0);

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
          title="Attention"
          action={<StatusBadge label={`${attentionThreads.length}`} tone="warning" />}
        />

        <View style={styles.metricRow}>
          <MetricCard
            label="Needs input"
            value={sections.find((section) => section.key === "input")?.items.length ?? 0}
            tone="warning"
          />
          <MetricCard
            label="Diff ready"
            value={sections.find((section) => section.key === "review")?.items.length ?? 0}
            tone="accent"
          />
          <MetricCard
            label="Errored"
            value={sections.find((section) => section.key === "error")?.items.length ?? 0}
            tone="danger"
          />
        </View>

        {sections.length === 0 ? (
          <View style={styles.emptyWrap}>
            <EmptyState
              title="All clear"
              body="Input requests, failures, completed runs, and diff-ready threads will collect here."
            />
          </View>
        ) : (
          sections.map((section) => {
            const meta = SECTION_META[section.key];
            return (
              <View key={section.key} style={styles.section}>
                <View style={styles.sectionHeader}>
                  <SectionTitle>{meta.title}</SectionTitle>
                  <StatusBadge label={`${section.items.length}`} tone={meta.tone} />
                </View>
                <Panel padded={false} style={styles.listShell}>
                  {section.items.map((entry, index) => (
                    <AttentionRow
                      key={`${entry.hostId}-${entry.thread.id}`}
                      entry={entry}
                      index={index}
                      total={section.items.length}
                      Icon={meta.Icon}
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
            );
          })
        )}

        {error ? (
          <NoticeBanner tone="danger" title="Unable to refresh attention feed" body={error} />
        ) : null}
      </ScrollView>
    </View>
  );
}

function AttentionRow({
  entry,
  index,
  total,
  Icon,
  onPress,
}: {
  entry: MobileThreadSummary;
  index: number;
  total: number;
  Icon: typeof BellDot;
  onPress: () => void;
}) {
  const { colors } = useTheme();

  return (
    <View>
      <RowLink
        icon={Icon}
        title={entry.thread.title}
        meta={`${entry.projectTitle} · ${entry.hostName}`}
        tone={entry.status.tone}
        onPress={onPress}
      />
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.detailStrip,
          {
            backgroundColor: pressed ? withAlpha(colors.foreground, 0.03) : "transparent",
          },
        ]}
      >
        <Text style={[styles.detailBody, { color: colors.secondaryLabel }]} numberOfLines={2}>
          {entry.attentionActivity?.summary ?? entry.preview}
        </Text>
        <Text style={[styles.detailTime, { color: colors.tertiaryLabel }]}>
          {formatTimeAgo(entry.lastActivityAt)}
        </Text>
      </Pressable>
      {index < total - 1 ? (
        <View style={[styles.separator, { backgroundColor: colors.separator }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  metricRow: {
    marginTop: 22,
    flexDirection: "row",
    gap: 10,
  },
  emptyWrap: {
    marginTop: 22,
  },
  section: {
    marginTop: 22,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  listShell: {
    overflow: "hidden",
  },
  detailStrip: {
    marginTop: -8,
    paddingHorizontal: 70,
    paddingBottom: 16,
    paddingRight: 18,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  detailBody: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  detailTime: {
    fontSize: 12,
    fontWeight: "700",
  },
  separator: {
    marginLeft: 18,
    marginRight: 18,
    height: StyleSheet.hairlineWidth,
  },
});
