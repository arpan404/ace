import React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Bell,
  CircleAlert,
  FileDiff,
  MessageSquareMore,
  ShieldAlert,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react-native";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { useTheme } from "../../src/design/ThemeContext";
import {
  EmptyState,
  IconButton,
  NoticeBanner,
  Panel,
  ScreenBackdrop,
  ScreenHeaderV2,
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
          title="Alerts"
          subtitle="Approvals, input requests, failures, and completions that need a glance."
          actions={
            <View style={styles.headerActions}>
              <IconButton icon={Bell} label={String(attentionThreads.length)} onPress={() => {}} />
              <IconButton
                icon={SlidersHorizontal}
                label="Settings"
                onPress={() => router.push("/settings")}
              />
            </View>
          }
        />

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
                <Panel style={styles.listShell}>
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
  Icon: typeof Bell;
  onPress: () => void;
}) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.attentionRow,
        {
          backgroundColor: pressed ? withAlpha(colors.text.primary, 0.03) : "transparent",
          borderBottomColor: index < total - 1 ? colors.border.soft : "transparent",
        },
      ]}
    >
      <View style={styles.attentionMain}>
        <View
          style={[
            styles.attentionIcon,
            { backgroundColor: withAlpha(colors.accent.primary, 0.12) },
          ]}
        >
          <Icon size={16} color={colors.accent.primary} strokeWidth={2.1} />
        </View>
        <View style={styles.attentionCopy}>
          <Text style={[styles.attentionTitle, { color: colors.text.primary }]} numberOfLines={1}>
            {entry.thread.title}
          </Text>
          <Text style={[styles.attentionMeta, { color: colors.text.secondary }]} numberOfLines={1}>
            {entry.projectTitle} · {entry.hostName}
          </Text>
          <Text style={[styles.attentionBody, { color: colors.text.tertiary }]} numberOfLines={2}>
            {entry.attentionActivity?.summary ?? entry.preview}
          </Text>
        </View>
        <View style={styles.attentionTrailing}>
          <Text style={[styles.attentionTime, { color: colors.text.tertiary }]}>
            {formatTimeAgo(entry.lastActivityAt)}
          </Text>
          <ChevronRight size={16} color={colors.text.tertiary} />
        </View>
      </View>
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
  emptyWrap: {
    marginTop: 22,
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  listShell: {
    paddingHorizontal: 16,
  },
  attentionRow: {
    minHeight: 82,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  attentionMain: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  attentionIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  attentionCopy: {
    flex: 1,
  },
  attentionTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  attentionMeta: {
    marginTop: 3,
    fontSize: 13,
  },
  attentionBody: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  attentionTrailing: {
    alignItems: "flex-end",
    gap: 8,
  },
  attentionTime: {
    fontSize: 11,
  },
});
