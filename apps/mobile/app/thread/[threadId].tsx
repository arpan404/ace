import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUp, ChevronLeft, Square, Terminal } from "lucide-react-native";
import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@ace/contracts";
import { newCommandId, newMessageId } from "@ace/shared/ids";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { Panel, ScreenBackdrop, SectionTitle, StatusBadge } from "../../src/design/primitives";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { upsertThreadMessage } from "../../src/chat/threadMessages";
import { formatTimeAgo, resolveMobileThreadStatus } from "../../src/orchestration/mobileData";

type ThreadPanel = "chat" | "diff" | "todo";

const PANEL_OPTIONS: ReadonlyArray<{ key: ThreadPanel; label: string }> = [
  { key: "chat", label: "Chat" },
  { key: "diff", label: "Diff" },
  { key: "todo", label: "Todo" },
];

export default function ThreadChatScreen() {
  const { threadId, hostId } = useLocalSearchParams<{
    threadId: string;
    hostId: string;
  }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [connection, setConnection] = useState<ManagedConnection | null>(null);
  const [thread, setThread] = useState<OrchestrationThread | null>(null);
  const [messages, setMessages] = useState<readonly OrchestrationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activePanel, setActivePanel] = useState<ThreadPanel>("chat");
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const connected = connectionManager
      .getConnections()
      .find((candidate) => candidate.host.id === hostId);
    setConnection(connected ?? null);

    return connectionManager.onStatusChange((connections) => {
      setConnection(connections.find((candidate) => candidate.host.id === hostId) ?? null);
    });
  }, [hostId]);

  const loadThread = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || !threadId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const nextThread = await connection.client.orchestration.getThread(threadId as never);
      setThread(nextThread);
      setMessages(nextThread.messages);
    } finally {
      setLoading(false);
    }
  }, [connection, threadId]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  useEffect(() => {
    if (!connection || connection.status.kind !== "connected" || !threadId) {
      return;
    }

    return connection.client.orchestration.onDomainEvent((event) => {
      if (event.aggregateId !== threadId) {
        return;
      }

      if (event.type === "thread.message-sent" && "message" in event.payload) {
        const nextMessage = event.payload.message as OrchestrationMessage;
        setMessages((currentMessages) => upsertThreadMessage(currentMessages, nextMessage));
      }

      void loadThread();
    });
  }, [connection, loadThread, threadId]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !connection || connection.status.kind !== "connected" || !thread) {
      return;
    }

    const text = input.trim();
    setInput("");
    setSending(true);

    try {
      await connection.client.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString() as never,
      });
    } finally {
      setSending(false);
    }
  }, [connection, input, thread]);

  const handleInterrupt = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || !thread) {
      return;
    }

    await connection.client.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: thread.id,
    } as never);
  }, [connection, thread]);

  const status = useMemo(() => (thread ? resolveMobileThreadStatus(thread) : null), [thread]);
  const diffCheckpoint = thread?.checkpoints.at(-1) ?? null;
  const todoActivities = useMemo(
    () => (thread?.activities ?? []).filter((activity) => activity.tone !== "info"),
    [thread?.activities],
  );
  const toolActivities = useMemo(
    () => (thread?.activities ?? []).filter((activity) => activity.tone === "tool").slice(-3),
    [thread?.activities],
  );
  const isRunning = thread?.session?.status === "running" || thread?.session?.status === "starting";

  if (loading && !thread) {
    return (
      <View style={[styles.loadingRoot, { backgroundColor: colors.background }]}>
        <ScreenBackdrop />
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <Stack.Screen options={{ headerShown: false }} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 18 : 0}
      >
        <View
          style={[
            styles.header,
            {
              paddingTop: insets.top + 10,
              backgroundColor: colors.background,
            },
          ]}
        >
          <View style={styles.headerRow}>
            <Pressable
              onPress={() => router.back()}
              style={[
                styles.headerButton,
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
              <Text style={[styles.eyebrow, { color: colors.tertiaryLabel }]}>
                {thread ? formatTimeAgo(thread.updatedAt) : ""}
              </Text>
              <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
                {thread?.title ?? "Thread"}
              </Text>
              <Text
                style={[styles.headerSubtitle, { color: colors.secondaryLabel }]}
                numberOfLines={1}
              >
                {connection?.host.name ?? "Unknown host"}
              </Text>
            </View>

            {isRunning ? (
              <Pressable
                onPress={() => void handleInterrupt()}
                style={[
                  styles.stopButton,
                  {
                    backgroundColor: withAlpha(colors.red, 0.14),
                    borderColor: withAlpha(colors.red, 0.2),
                  },
                ]}
              >
                <Square size={12} color={colors.red} fill={colors.red} />
                <Text style={[styles.stopLabel, { color: colors.red }]}>Stop</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/thread/terminal",
                    params: { threadId, hostId },
                  })
                }
                style={[
                  styles.headerButton,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.elevatedBorder,
                    shadowColor: colors.shadow,
                  },
                ]}
              >
                <Terminal size={18} color={colors.foreground} strokeWidth={2.2} />
              </Pressable>
            )}
          </View>

          <Panel style={styles.summaryPanel}>
            <View style={styles.summaryTop}>
              {status ? <StatusBadge label={status.label} tone={status.tone} /> : null}
              <Text style={[styles.summaryMeta, { color: colors.tertiaryLabel }]}>
                {messages.length} messages
              </Text>
            </View>
            <View style={styles.panelTabs}>
              {PANEL_OPTIONS.map((panel) => {
                const active = panel.key === activePanel;
                return (
                  <Pressable
                    key={panel.key}
                    onPress={() => setActivePanel(panel.key)}
                    style={[
                      styles.panelTab,
                      {
                        backgroundColor: active ? colors.surfaceSecondary : "transparent",
                        borderColor: active ? colors.elevatedBorder : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.panelTabLabel,
                        { color: active ? colors.foreground : colors.secondaryLabel },
                      ]}
                    >
                      {panel.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Panel>
        </View>

        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: insets.bottom + 20,
            },
          ]}
          onContentSizeChange={() => {
            if (activePanel === "chat") {
              scrollRef.current?.scrollToEnd({ animated: true });
            }
          }}
        >
          {activePanel === "chat" ? (
            <ChatPanel messages={messages} toolActivities={toolActivities} thread={thread} />
          ) : null}

          {activePanel === "diff" ? <DiffPanel checkpoint={diffCheckpoint} /> : null}

          {activePanel === "todo" ? (
            <TodoPanel
              activities={todoActivities}
              hasProposedPlan={thread?.latestProposedPlanSummary !== null}
            />
          ) : null}
        </ScrollView>

        <View
          style={[
            styles.composer,
            {
              backgroundColor: colors.background,
              borderTopColor: colors.separator,
              paddingBottom: insets.bottom + 8,
            },
          ]}
        >
          <View
            style={[
              styles.composerField,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
                shadowColor: colors.shadow,
              },
            ]}
          >
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Send a follow-up or instruction"
              placeholderTextColor={colors.muted}
              style={[styles.textInput, { color: colors.foreground }]}
              multiline
              editable={!sending}
            />
            <Pressable
              onPress={() => void handleSend()}
              disabled={!input.trim() || sending}
              style={[
                styles.sendButton,
                {
                  backgroundColor: input.trim() ? colors.primary : colors.surfaceSecondary,
                },
              ]}
            >
              <ArrowUp
                size={16}
                color={input.trim() ? colors.primaryForeground : colors.muted}
                strokeWidth={2.5}
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function ChatPanel({
  messages,
  toolActivities,
  thread,
}: {
  messages: readonly OrchestrationMessage[];
  toolActivities: ReadonlyArray<OrchestrationThreadActivity>;
  thread: OrchestrationThread | null;
}) {
  const { colors } = useTheme();

  return (
    <View style={styles.chatPanel}>
      {messages.map((message) => {
        const isUser = message.role === "user";

        return (
          <View
            key={message.id}
            style={[
              styles.messageCard,
              isUser
                ? [
                    styles.userMessage,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]
                : [
                    styles.assistantMessage,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.elevatedBorder,
                    },
                  ],
            ]}
          >
            <Text style={[styles.messageRole, { color: colors.tertiaryLabel }]}>
              {isUser ? "You" : "Agent"}
            </Text>
            <Text style={[styles.messageText, { color: colors.foreground }]}>
              {message.text}
              {message.streaming ? " ▍" : ""}
            </Text>
          </View>
        );
      })}

      {toolActivities.length > 0 ? (
        <Panel>
          <SectionTitle>Recent tool activity</SectionTitle>
          <View style={styles.toolList}>
            {toolActivities.map((activity) => (
              <View
                key={activity.id}
                style={[
                  styles.toolRow,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <Text style={[styles.toolSummary, { color: colors.foreground }]} numberOfLines={2}>
                  {activity.summary}
                </Text>
              </View>
            ))}
          </View>
        </Panel>
      ) : null}

      {messages.length === 0 && !thread ? (
        <Text style={[styles.placeholderText, { color: colors.muted }]}>No thread loaded.</Text>
      ) : null}
    </View>
  );
}

function DiffPanel({ checkpoint }: { checkpoint: OrchestrationCheckpointSummary | null }) {
  const { colors } = useTheme();

  if (!checkpoint) {
    return (
      <Panel>
        <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>No diff yet</Text>
        <Text style={[styles.placeholderText, { color: colors.secondaryLabel }]}>
          Diff-ready turns will show changed files here once a checkpoint is available.
        </Text>
      </Panel>
    );
  }

  return (
    <Panel>
      <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>Latest checkpoint</Text>
      <Text style={[styles.placeholderMeta, { color: colors.secondaryLabel }]}>
        {checkpoint.files.length} files · {formatTimeAgo(checkpoint.completedAt)}
      </Text>
      <View style={styles.fileList}>
        {checkpoint.files.map((file) => (
          <View
            key={`${checkpoint.turnId}-${file.path}`}
            style={[
              styles.fileRow,
              {
                borderColor: colors.elevatedBorder,
                backgroundColor: colors.surfaceSecondary,
              },
            ]}
          >
            <Text style={[styles.filePath, { color: colors.foreground }]} numberOfLines={1}>
              {file.path}
            </Text>
            <Text style={[styles.fileMeta, { color: colors.secondaryLabel }]}>
              +{file.additions} / -{file.deletions}
            </Text>
          </View>
        ))}
      </View>
    </Panel>
  );
}

function TodoPanel({
  activities,
  hasProposedPlan,
}: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  hasProposedPlan: boolean;
}) {
  const { colors } = useTheme();

  return (
    <Panel>
      <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>Thread focus</Text>
      <Text style={[styles.placeholderText, { color: colors.secondaryLabel }]}>
        {hasProposedPlan
          ? "A proposed plan is attached to this thread."
          : "Approvals, errors, and tool activity appear here as the run evolves."}
      </Text>
      <View style={styles.fileList}>
        {activities.length === 0 ? (
          <Text style={[styles.placeholderText, { color: colors.muted }]}>No active items.</Text>
        ) : (
          activities.map((activity) => (
            <View
              key={activity.id}
              style={[
                styles.todoRow,
                {
                  borderColor: colors.elevatedBorder,
                  backgroundColor: colors.surfaceSecondary,
                },
              ]}
            >
              <Text style={[styles.todoKind, { color: colors.tertiaryLabel }]}>
                {activity.kind.replaceAll(".", " ")}
              </Text>
              <Text style={[styles.todoSummary, { color: colors.foreground }]}>
                {activity.summary}
              </Text>
            </View>
          ))
        )}
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  loadingRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    paddingHorizontal: Layout.pagePadding,
    paddingBottom: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
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
    letterSpacing: 0.24,
    textTransform: "uppercase",
  },
  headerTitle: {
    marginTop: 6,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  headerSubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  stopButton: {
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  stopLabel: {
    fontSize: 12,
    fontWeight: "700",
  },
  summaryPanel: {
    marginTop: 18,
  },
  summaryTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  summaryMeta: {
    fontSize: 12,
    fontWeight: "700",
  },
  panelTabs: {
    marginTop: 16,
    flexDirection: "row",
    gap: 10,
  },
  panelTab: {
    flex: 1,
    minHeight: 42,
    borderWidth: 1,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTabLabel: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
  content: {
    paddingHorizontal: Layout.pagePadding,
    gap: 14,
  },
  chatPanel: {
    gap: 12,
  },
  messageCard: {
    borderWidth: 1,
    borderRadius: Radius.card,
    paddingHorizontal: 16,
    paddingVertical: 15,
    maxWidth: "92%",
  },
  userMessage: {
    alignSelf: "flex-end",
  },
  assistantMessage: {
    alignSelf: "flex-start",
  },
  messageRole: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  messageText: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
  },
  toolList: {
    marginTop: 14,
    gap: 10,
  },
  toolRow: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toolSummary: {
    fontSize: 14,
    lineHeight: 20,
  },
  placeholderTitle: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  placeholderMeta: {
    marginTop: 8,
    fontSize: 13,
  },
  placeholderText: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
  },
  fileList: {
    marginTop: 16,
    gap: 10,
  },
  fileRow: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  filePath: {
    fontSize: 14,
    fontWeight: "700",
  },
  fileMeta: {
    marginTop: 5,
    fontSize: 12,
    fontWeight: "600",
  },
  todoRow: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  todoKind: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  todoSummary: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 20,
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Layout.pagePadding,
    paddingTop: 12,
  },
  composerField: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
    borderWidth: 1,
    borderRadius: Radius.panel,
    paddingLeft: 16,
    paddingRight: 10,
    paddingVertical: 10,
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.1,
    shadowRadius: 28,
    elevation: 0,
  },
  textInput: {
    flex: 1,
    minHeight: 24,
    maxHeight: 120,
    fontSize: 15,
    lineHeight: 21,
    paddingTop: 4,
    paddingBottom: 4,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
