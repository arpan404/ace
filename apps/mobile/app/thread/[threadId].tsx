import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  FlatList,
  StyleSheet,
  Text,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Terminal, ArrowUp, Square } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { useHostStore } from "../../src/store/HostStore";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { upsertThreadMessage } from "../../src/chat/threadMessages";
import type { OrchestrationMessage, OrchestrationThread } from "@ace/contracts";

function timeStamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ThreadChatScreen() {
  const { threadId, hostId } = useLocalSearchParams<{
    threadId: string;
    hostId: string;
  }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const _hosts = useHostStore((s) => s.hosts);

  const [conn, setConn] = useState<ManagedConnection | null>(null);
  const [thread, setThread] = useState<OrchestrationThread | null>(null);
  const [messages, setMessages] = useState<readonly OrchestrationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    const conns = connectionManager.getConnections();
    const found = conns.find((c) => c.host.id === hostId) ?? null;
    setConn(found);
    return connectionManager.onStatusChange((updated) => {
      setConn(updated.find((c) => c.host.id === hostId) ?? null);
    });
  }, [hostId]);

  useEffect(() => {
    if (!conn || conn.status.kind !== "connected" || !threadId) return;

    let mounted = true;
    const loadThread = async () => {
      try {
        const t = await conn.client.orchestration.getThread(threadId);
        if (mounted) {
          setThread(t);
          setMessages(t.messages);
          setLoading(false);
        }
      } catch {
        if (mounted) setLoading(false);
      }
    };

    void loadThread();

    const unsub = conn.client.orchestration.onDomainEvent((event) => {
      if (event.aggregateId !== threadId) return;
      if (event.type === "thread.message.sent" && "message" in event.payload) {
        const msg = event.payload.message as OrchestrationMessage;
        setMessages((prev) => upsertThreadMessage(prev, msg));
      }
      if (event.type === "thread.session.set" || event.type === "thread.turn.startRequested") {
        void loadThread();
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [conn, threadId]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !conn || conn.status.kind !== "connected" || !thread) return;

    const text = input.trim();
    setInput("");
    setSending(true);

    try {
      await conn.client.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: crypto.randomUUID(),
        threadId: thread.id,
        message: {
          messageId: crypto.randomUUID(),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString() as never,
      });
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setSending(false);
    }
  }, [input, conn, thread]);

  const handleInterrupt = useCallback(async () => {
    if (!conn || conn.status.kind !== "connected" || !thread) return;
    try {
      await conn.client.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: crypto.randomUUID(),
        threadId: thread.id,
      } as never);
    } catch (err) {
      console.error("Failed to interrupt:", err);
    }
  }, [conn, thread]);

  const isRunning = thread?.session?.status === "running" || thread?.session?.status === "starting";
  const sessionStatus = thread?.session?.status ?? "idle";

  const renderMessage = useCallback(
    ({ item }: { item: OrchestrationMessage }) => {
      const isUser = item.role === "user";
      const isStreaming = item.streaming;
      return (
        <View
          style={[
            styles.messageBubble,
            isUser
              ? [styles.userBubble, { backgroundColor: colors.primary }]
              : [styles.assistantBubble, { backgroundColor: `${colors.muted}20` }],
          ]}
        >
          <Text style={[styles.messageText, { color: isUser ? "#fff" : colors.foreground }]}>
            {item.text}
            {isStreaming ? " ▍" : ""}
          </Text>
          <Text
            style={[styles.messageTime, { color: isUser ? "rgba(255,255,255,0.6)" : colors.muted }]}
          >
            {timeStamp(item.createdAt)}
          </Text>
        </View>
      );
    },
    [colors],
  );

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <Stack.Screen
          options={{
            headerShown: true,
            title: "Thread",
            headerBackTitleVisible: false,
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.primary,
            headerTitleStyle: { color: colors.foreground },
          }}
        />
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: thread?.title ?? "Thread",
          headerBackTitleVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.foreground, fontSize: 16 },
          headerRight: () => (
            <View style={styles.headerRight}>
              {isRunning && (
                <Pressable
                  onPress={() => void handleInterrupt()}
                  style={[styles.interruptBtn, { borderColor: colors.red }]}
                >
                  <Square size={12} color={colors.red} fill={colors.red} />
                  <Text style={[styles.interruptText, { color: colors.red }]}>Stop</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/thread/terminal",
                    params: { threadId, hostId },
                  })
                }
                hitSlop={8}
              >
                <Terminal size={20} color={colors.primary} strokeWidth={2} />
              </Pressable>
            </View>
          ),
        }}
      />

      {/* Session Status Bar */}
      {sessionStatus !== "idle" && (
        <View
          style={[
            styles.sessionBar,
            {
              backgroundColor:
                sessionStatus === "running" || sessionStatus === "starting"
                  ? `${colors.green}14`
                  : sessionStatus === "error"
                    ? `${colors.red}14`
                    : `${colors.orange}14`,
            },
          ]}
        >
          <Text
            style={[
              styles.sessionBarText,
              {
                color:
                  sessionStatus === "running" || sessionStatus === "starting"
                    ? colors.green
                    : sessionStatus === "error"
                      ? colors.red
                      : colors.orange,
              },
            ]}
          >
            {sessionStatus === "running"
              ? "Agent is working…"
              : sessionStatus === "starting"
                ? "Starting session…"
                : sessionStatus === "ready"
                  ? "Agent is ready"
                  : sessionStatus === "interrupted"
                    ? "Agent interrupted"
                    : sessionStatus === "error"
                      ? `Error: ${thread?.session?.lastError ?? "Unknown"}`
                      : sessionStatus}
          </Text>
        </View>
      )}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={100}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={[styles.messageList, { paddingBottom: 12 }]}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            <View style={styles.emptyMessages}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                No messages yet. Send a message to start a conversation.
              </Text>
            </View>
          }
        />

        {/* Input Bar */}
        <View
          style={[
            styles.inputBar,
            {
              backgroundColor: colors.background,
              borderTopColor: colors.separator,
              paddingBottom: insets.bottom + 8,
            },
          ]}
        >
          <TextInput
            style={[
              styles.textInput,
              {
                backgroundColor: `${colors.muted}20`,
                color: colors.foreground,
              },
            ]}
            placeholder="Send a message…"
            placeholderTextColor={colors.muted}
            value={input}
            onChangeText={setInput}
            multiline
            maxLength={10000}
            editable={!sending}
          />
          <Pressable
            onPress={() => void handleSend()}
            disabled={!input.trim() || sending}
            style={[
              styles.sendButton,
              {
                backgroundColor: input.trim() && !sending ? colors.primary : colors.fill,
              },
            ]}
          >
            <ArrowUp
              size={18}
              color={input.trim() && !sending ? "#fff" : colors.muted}
              strokeWidth={2.5}
            />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 14 },
  interruptBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  interruptText: { fontSize: 14, fontWeight: "600" },
  sessionBar: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  sessionBarText: { fontSize: 14, fontWeight: "500" },
  messageList: { paddingHorizontal: 16, paddingTop: 12 },
  messageBubble: {
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    marginBottom: 8,
  },
  userBubble: { alignSelf: "flex-end", borderBottomRightRadius: 4 },
  assistantBubble: { alignSelf: "flex-start", borderBottomLeftRadius: 4 },
  messageText: { fontSize: 16, lineHeight: 22 },
  messageTime: { fontSize: 11, marginTop: 4, alignSelf: "flex-end" },
  emptyMessages: {
    flex: 1,
    paddingVertical: 60,
    alignItems: "center",
    paddingHorizontal: 32,
  },
  emptyText: { fontSize: 15, textAlign: "center", lineHeight: 22 },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  textInput: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 120,
    minHeight: 40,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
});
