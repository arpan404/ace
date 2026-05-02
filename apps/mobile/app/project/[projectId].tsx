import React, { useMemo } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, FolderGit2 } from "lucide-react-native";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { useTheme } from "../../src/design/ThemeContext";
import {
  EmptyState,
  MetricCard,
  Panel,
  ScreenBackdrop,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { formatTimeAgo, useAggregatedOrchestration } from "../../src/orchestration/mobileData";

export default function ProjectDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { projectId, hostId } = useLocalSearchParams<{ projectId: string; hostId?: string }>();
  const { projects, threads, refresh, loading } = useAggregatedOrchestration();

  const entry = useMemo(
    () =>
      projects.find((project) => {
        if (project.project.id !== projectId) {
          return false;
        }
        if (!hostId) {
          return true;
        }
        return project.hostId === hostId;
      }) ?? null,
    [hostId, projectId, projects],
  );

  const projectThreads = useMemo(
    () =>
      threads.filter(
        (thread) => thread.thread.projectId === projectId && (!hostId || thread.hostId === hostId),
      ),
    [hostId, projectId, threads],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 48,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => router.back()}
            style={[
              styles.backButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
                shadowColor: colors.shadow,
              },
            ]}
          >
            <ChevronLeft size={18} color={colors.foreground} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={[styles.eyebrow, { color: colors.tertiaryLabel }]}>Project</Text>
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
              {entry?.project.title ?? "Project"}
            </Text>
            <Text style={[styles.subtitle, { color: colors.secondaryLabel }]} numberOfLines={1}>
              {entry?.hostName ?? "Unknown host"} · {projectThreads.length} threads
            </Text>
          </View>
        </View>

        {entry ? (
          <>
            <Panel style={styles.heroPanel}>
              <View style={styles.heroRow}>
                <View
                  style={[
                    styles.heroIcon,
                    {
                      backgroundColor: withAlpha(colors.primary, 0.14),
                    },
                  ]}
                >
                  <FolderGit2 size={20} color={colors.primary} strokeWidth={2.1} />
                </View>
                <View style={styles.heroCopy}>
                  <Text style={[styles.heroLabel, { color: colors.tertiaryLabel }]}>
                    Workspace root
                  </Text>
                  <Text style={[styles.heroPath, { color: colors.foreground }]} numberOfLines={2}>
                    {entry.project.workspaceRoot}
                  </Text>
                </View>
              </View>
            </Panel>

            <View style={styles.metricRow}>
              <MetricCard label="Live" value={entry.liveCount} tone="success" />
              <MetricCard label="Pending" value={entry.pendingCount} tone="warning" />
              <MetricCard label="Completed" value={entry.completedCount} tone="muted" />
            </View>
          </>
        ) : null}

        <View style={styles.sectionHeader}>
          <SectionTitle>Threads</SectionTitle>
          <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
            {projectThreads.length} total
          </Text>
        </View>

        {projectThreads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            body="This project will populate once a thread starts on the connected host."
          />
        ) : (
          <Panel padded={false} style={styles.listShell}>
            {projectThreads.map((thread, index) => (
              <Pressable
                key={`${thread.hostId}-${thread.thread.id}`}
                onPress={() =>
                  router.push({
                    pathname: "/thread/[threadId]",
                    params: { threadId: thread.thread.id, hostId: thread.hostId },
                  })
                }
                style={({ pressed }) => [
                  styles.threadRow,
                  {
                    backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
                  },
                ]}
              >
                <View style={styles.threadCopy}>
                  <View style={styles.threadTitleRow}>
                    <Text
                      style={[styles.threadTitle, { color: colors.foreground }]}
                      numberOfLines={1}
                    >
                      {thread.thread.title}
                    </Text>
                    <StatusBadge label={thread.status.label} tone={thread.status.tone} />
                  </View>
                  <Text
                    style={[styles.threadPreview, { color: colors.secondaryLabel }]}
                    numberOfLines={2}
                  >
                    {thread.preview}
                  </Text>
                  <Text
                    style={[styles.threadMeta, { color: colors.tertiaryLabel }]}
                    numberOfLines={1}
                  >
                    {thread.hostName} · {formatTimeAgo(thread.lastActivityAt)}
                  </Text>
                </View>
                {index < projectThreads.length - 1 ? (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                ) : null}
              </Pressable>
            ))}
          </Panel>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  backButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.14,
    shadowRadius: 28,
    elevation: 0,
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.34,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 8,
    fontSize: 32,
    lineHeight: 34,
    fontWeight: "800",
    letterSpacing: -1.1,
  },
  subtitle: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
  },
  heroPanel: {
    marginTop: 22,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  heroIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  heroCopy: {
    flex: 1,
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.24,
  },
  heroPath: {
    marginTop: 8,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
  },
  metricRow: {
    marginTop: 14,
    flexDirection: "row",
    gap: 10,
  },
  sectionHeader: {
    marginTop: 24,
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
    minHeight: 104,
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  threadCopy: {
    flex: 1,
  },
  threadTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  threadTitle: {
    flex: 1,
    fontSize: 19,
    lineHeight: 23,
    fontWeight: "800",
    letterSpacing: -0.45,
  },
  threadPreview: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
  },
  threadMeta: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 18,
    right: 18,
    height: StyleSheet.hairlineWidth,
  },
});
