import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { Send } from "lucide-react-native";
import Markdown from "react-native-markdown-display";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { connectionManager } from "../../src/rpc/ConnectionManager";
import type { OrchestrationThread, OrchestrationMessage } from "@ace/contracts";
import { LiquidScreen } from "../../src/design/LiquidGlass";
import { formatErrorMessage } from "../../src/errors";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
} from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function ChatScreen() {
  const { threadId, hostId } = useLocalSearchParams<{ threadId: string; hostId: string }>();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [thread, setThread] = useState<OrchestrationThread | null>(null);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const flatListRef = useRef<FlatList<OrchestrationMessage>>(null);

  const conn = connectionManager.getConnections().find((c) => c.host.id === hostId);
  const canSend = inputText.trim().length > 0 && !sending;
  const sendScale = useSharedValue(1);

  const sendAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: sendScale.value }],
  }));

  useEffect(() => {
    if (!threadId) {
      setLoadError("Thread id is missing.");
      setLoading(false);
      return;
    }
    if (!conn || conn.status.kind !== "connected") {
      setLoadError("Host connection is unavailable.");
      setLoading(false);
      return;
    }

    let mounted = true;
    setLoading(true);
    setLoadError(null);

    void conn.client.orchestration
      .getThread(threadId)
      .then((nextThread) => {
        if (!mounted) {
          return;
        }
        setThread(nextThread);
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }
        const message = formatErrorMessage(error);
        console.error(`Failed to load thread ${threadId}: ${message}`);
        setLoadError(message);
      })
      .finally(() => {
        if (!mounted) {
          return;
        }
        setLoading(false);
      });

    const cleanup = conn.client.orchestration.onDomainEvent((event) => {
      if (event.type !== "thread.message-sent" || event.payload.threadId !== threadId) {
        return;
      }

      const incomingMessage: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        attachments: event.payload.attachments,
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        sequence: event.payload.sequence,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      };

      setThread((prev) => {
        if (!prev) {
          return prev;
        }
        if (prev.messages.some((message) => message.id === incomingMessage.id)) {
          return prev;
        }
        return { ...prev, messages: [...prev.messages, incomingMessage] };
      });
    });

    return () => {
      mounted = false;
      cleanup();
    };
  }, [conn, threadId]);

  const handleSend = async () => {
    if (!canSend) {
      return;
    }
    if (!conn || conn.status.kind !== "connected" || !threadId) {
      Alert.alert("Connection unavailable", "Reconnect the host before sending a message.");
      return;
    }

    setSendError(null);
    setSending(true);
    const textToSend = inputText.trim();
    setInputText("");

    try {
      await conn.client.orchestration.dispatchCommand({
        kind: "msg",
        threadId,
        text: textToSend,
      });
    } catch (error) {
      const message = formatErrorMessage(error);
      console.error(`Failed to send message to thread ${threadId}: ${message}`);
      setSendError(message);
      setInputText(textToSend);
      Alert.alert("Failed to send message", message);
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item }: { item: OrchestrationMessage }) => {
    const isUser = item.role === "user";

    return (
      <View style={[styles.messageWrapper, { alignItems: isUser ? "flex-end" : "flex-start" }]}>
        <View
          style={[
            styles.messageBubble,
            {
              backgroundColor: isUser ? theme.primary : theme.card,
              borderBottomRightRadius: isUser ? 4 : 20,
              borderBottomLeftRadius: isUser ? 20 : 4,
            },
          ]}
        >
          <Markdown
            style={{
              body: {
                color: isUser ? theme.primaryForeground : theme.foreground,
                fontSize: 16,
                lineHeight: 22,
              },
              link: { color: isUser ? "#ffffff" : theme.primary, textDecorationLine: "underline" },
              code_inline: {
                backgroundColor: isUser
                  ? "rgba(0,0,0,0.15)"
                  : isDark
                    ? "rgba(255,255,255,0.08)"
                    : "rgba(0,0,0,0.05)",
                borderRadius: 6,
                color: isUser ? theme.primaryForeground : theme.foreground,
              },
              code_block: {
                backgroundColor: isUser ? "rgba(0,0,0,0.15)" : isDark ? "#000000" : "#f2f2f7",
                padding: 12,
                borderRadius: 12,
                marginTop: 8,
                marginBottom: 8,
              },
              fence: {
                backgroundColor: isUser ? "rgba(0,0,0,0.15)" : isDark ? "#000000" : "#f2f2f7",
                padding: 12,
                borderRadius: 12,
                marginTop: 8,
                marginBottom: 8,
                color: isUser ? theme.primaryForeground : theme.foreground,
              },
            }}
          >
            {item.text}
          </Markdown>
        </View>
        <Text
          style={[
            styles.messageTime,
            { color: theme.mutedForeground, alignSelf: isUser ? "flex-end" : "flex-start" },
          ]}
        >
          {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </Text>
      </View>
    );
  };

  if (loading) {
    return (
      <LiquidScreen>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      </LiquidScreen>
    );
  }

  if (loadError && !thread) {
    return (
      <LiquidScreen>
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: theme.destructive }]}>{loadError}</Text>
        </View>
      </LiquidScreen>
    );
  }

  return (
    <LiquidScreen>
      <Stack.Screen
        options={{
          headerShown: true,
          title: thread?.messages.at(-1)?.text.substring(0, 20) || "Thread",
          headerTitleStyle: { color: theme.foreground, fontSize: 17, fontWeight: "600" },
          headerBackTitleVisible: false,
          headerStyle: { backgroundColor: theme.background },
          headerShadowVisible: false,
          headerTintColor: theme.primary,
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <FlatList
          ref={flatListRef}
          data={thread?.messages ?? []}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        />

        <View
          style={[
            styles.inputWrap,
            { paddingBottom: Math.max(insets.bottom, 12), backgroundColor: theme.background },
          ]}
        >
          {sendError ? (
            <Text style={[styles.errorText, { color: theme.destructive }]}>{sendError}</Text>
          ) : null}
          <View
            style={[
              styles.inputBar,
              { backgroundColor: isDark ? theme.card : "#ffffff", borderColor: theme.border },
            ]}
          >
            <TextInput
              style={[styles.input, { color: theme.foreground }]}
              placeholder="Message..."
              placeholderTextColor={theme.mutedForeground}
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxHeight={120}
            />
            <AnimatedPressable
              onPress={handleSend}
              onPressIn={() => {
                if (canSend) sendScale.value = withTiming(0.85, { duration: 100 });
              }}
              onPressOut={() => {
                sendScale.value = withSpring(1, { damping: 15, stiffness: 300 });
              }}
              style={[
                styles.sendButton,
                sendAnimatedStyle,
                { backgroundColor: canSend ? theme.primary : theme.secondary },
              ]}
              disabled={!canSend}
            >
              {sending ? (
                <ActivityIndicator size="small" color={theme.primaryForeground} />
              ) : (
                <Send
                  size={16}
                  color={canSend ? theme.primaryForeground : theme.mutedForeground}
                  style={{ marginLeft: 2 }}
                />
              )}
            </AnimatedPressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </LiquidScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 16,
  },
  messageWrapper: {
    width: "100%",
    marginBottom: 4,
  },
  messageBubble: {
    maxWidth: "85%",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 2,
  },
  messageTime: {
    fontSize: 11,
    fontWeight: "500",
    marginTop: 6,
    paddingHorizontal: 4,
  },
  inputWrap: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.02,
    shadowRadius: 8,
    elevation: 4,
  },
  input: {
    flex: 1,
    minHeight: 36,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 16,
    lineHeight: 20,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 2,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 8,
    marginHorizontal: 4,
    textAlign: "center",
  },
});
