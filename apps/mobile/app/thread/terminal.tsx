import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Pressable,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";

export default function TerminalScreen() {
  const { threadId, hostId } = useLocalSearchParams<{
    threadId: string;
    hostId: string;
  }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [conn, setConn] = useState<ManagedConnection | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Find connection
  useEffect(() => {
    const conns = connectionManager.getConnections();
    setConn(conns.find((c) => c.host.id === hostId) ?? null);
    return connectionManager.onStatusChange((updated) => {
      setConn(updated.find((c) => c.host.id === hostId) ?? null);
    });
  }, [hostId]);

  // Open terminal session
  useEffect(() => {
    if (!conn || conn.status.kind !== "connected") return;

    let mounted = true;

    const openTerminal = async () => {
      try {
        const session = await conn.client.terminal.open({
          threadId: threadId ?? undefined,
        } as never);
        if (mounted) {
          setSessionId(session.id ?? threadId ?? "default");
          setOutput((prev) => [...prev, `--- Terminal session opened ---`]);
        }
      } catch (err) {
        if (mounted) {
          setOutput((prev) => [...prev, `Failed to open terminal: ${String(err)}`]);
        }
      }
    };

    void openTerminal();

    const unsub = conn.client.terminal.onEvent((event: unknown) => {
      if (!mounted) return;
      const ev = event as { data?: string; type?: string };
      if (ev.data) {
        setOutput((prev) => [...prev, ev.data!]);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [conn, threadId]);

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || !conn || conn.status.kind !== "connected") return;

    const text = input;
    setInput("");
    setOutput((prev) => [...prev, `$ ${text}`]);

    try {
      await conn.client.terminal.write({
        sessionId: sessionId ?? "default",
        data: text + "\n",
      } as never);
    } catch (err) {
      setOutput((prev) => [...prev, `Error: ${String(err)}`]);
    }
  }, [input, conn, sessionId]);

  return (
    <View style={[styles.root, { backgroundColor: "#1a1a2e" }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: "Terminal",
          headerBackTitleVisible: false,
          headerStyle: { backgroundColor: "#1a1a2e" },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: "#e0e0e0" },
        }}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={100}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.outputScroll}
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingTop: 8,
            paddingBottom: 12,
          }}
        >
          {output.length === 0 ? (
            <Text style={styles.placeholder}>Terminal session. Type a command below.</Text>
          ) : (
            output.map((line, i) => (
              <Text key={i} style={styles.outputLine}>
                {line}
              </Text>
            ))
          )}
        </ScrollView>

        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          <Text style={styles.prompt}>$</Text>
          <TextInput
            style={styles.textInput}
            value={input}
            onChangeText={setInput}
            placeholder="Enter command…"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={() => void handleSubmit()}
          />
          <Pressable
            onPress={() => void handleSubmit()}
            disabled={!input.trim()}
            style={[
              styles.sendBtn,
              {
                backgroundColor: input.trim() ? colors.primary : "rgba(255,255,255,0.1)",
              },
            ]}
          >
            <Text style={[styles.sendBtnText, { color: input.trim() ? "#fff" : "#666" }]}>↵</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  outputScroll: { flex: 1 },
  placeholder: {
    color: "#555",
    fontSize: 14,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    paddingVertical: 20,
  },
  outputLine: {
    color: "#e0e0e0",
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 20,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#333",
    backgroundColor: "#0d0d1a",
    gap: 8,
  },
  prompt: {
    color: "#4ade80",
    fontSize: 15,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontWeight: "700",
  },
  textInput: {
    flex: 1,
    color: "#e0e0e0",
    fontSize: 14,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    paddingVertical: 10,
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnText: { fontSize: 16, fontWeight: "700" },
});
