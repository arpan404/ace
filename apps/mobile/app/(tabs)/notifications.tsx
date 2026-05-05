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
  Settings2,
  ChevronRight,
} from "lucide-react-native";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { useTheme } from "../../src/design/ThemeContext";
import {
  EmptyState,
  IconButton,
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

  const displayTitle = "Alerts";

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <GlassScreenHeader
        title={displayTitle}
        action={
          <View style={styles.headerActions}>
            <IconButton icon={Settings2} label="Settings" onPress={() => router.push("/profile")} />
            <StatusBadge label={`${attentionThreads.length}`} tone="warning" />
          </View>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 180,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
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
                <View style={styles.listShell}>
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
                </View>
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
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.attentionRow,
        {
          backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
          borderColor: colors.elevatedBorder,
        },
      ]}
    >
      <View style={styles.attentionMain}>
        <View
          style={[
            styles.attentionIcon,
            { backgroundColor: withAlpha(colors.primary, 0.12) },
          ]}
        >
          <Icon size={18} color={colors.primary} strokeWidth={2.2} />
        </View>
        <View style={styles.attentionCopy}>
          <Text style={[styles.attentionTitle, { color: colors.foreground }]} numberOfLines={1}>
            {entry.thread.title}
          </Text>
          <Text style={[styles.attentionMeta, { color: colors.secondaryLabel }]} numberOfLines={1}>
            {entry.projectTitle} · {entry.hostName}
          </Text>
        </View>
        <ChevronRight size={18} color={colors.tertiaryLabel} />
      </View>
      <Text style={[styles.attentionBody, { color: colors.secondaryLabel }]} numberOfLines={2}>
        {entry.attentionActivity?.summary ?? entry.preview}
      </Text>
      <Text style={[styles.attentionTime, { color: colors.tertiaryLabel }]}>
        {formatTimeAgo(entry.lastActivityAt)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  metricRow: {
    flexDirection: "row",
    gap: 12,
  },
  emptyWrap: {
    marginTop: 22,
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  listShell: {
    gap: 12,
  },
  attentionRow: {
    padding: 16,
    borderRadius: Radius.card,
    borderWidth: 1.5,
    gap: 12,
  },
  attentionMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  attentionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  attentionCopy: {
    flex: 1,
  },
  attentionTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  attentionMeta: {
    marginTop: 2,
    fontSize: 13,
  },
  attentionBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  attentionTime: {
    fontSize: 12,
    fontWeight: "700",
  },
});
