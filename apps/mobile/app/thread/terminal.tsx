import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import {
  CornerDownLeft,
  Eraser,
  Paperclip,
  RefreshCw,
  RotateCcw,
  WifiOff,
} from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { formatErrorMessage } from "../../src/errors";
import { useMobileTerminalContextStore } from "../../src/store/MobileTerminalContextStore";
import {
  buildMobileTerminalContextFromOutput,
  hasMobileTerminalContextOutput,
} from "../../src/thread/mobileTerminalContexts";

type TerminalStatus = "idle" | "opening" | "open" | "offline" | "error";

const MOBILE_TERMINAL_ID = "mobile";

export default function TerminalScreen() {
  const { threadId, hostId, cwd, initialCommand } = useLocalSearchParams<{
    threadId: string;
    hostId: string;
    cwd?: string;
    initialCommand?: string;
  }>();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const termBg = isDark ? "#0d0d0d" : "#1a1a1a";
  const termFg = isDark ? "#e0e0e0" : "#d4d4d4";
  const termBarBg = isDark ? "#161616" : "#111111";

  const [conn, setConn] = useState<ManagedConnection | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ranInitialCommand, setRanInitialCommand] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>("idle");
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [terminalAction, setTerminalAction] = useState<"clear" | "restart" | null>(null);
  const addThreadContext = useMobileTerminalContextStore((state) => state.addThreadContext);
  const terminalThreadId = threadId ?? "mobile-terminal";
  const scrollRef = useRef<ScrollView>(null);
  const outputEntries = useMemo(() => {
    const lineOccurrences = new Map<string, number>();
    return output.map((line) => {
      const nextOccurrence = (lineOccurrences.get(line) ?? 0) + 1;
      lineOccurrences.set(line, nextOccurrence);
      return {
        key: `${line}-${nextOccurrence}`,
        line,
      };
    });
  }, [output]);

  useEffect(() => {
    const conns = connectionManager.getConnections();
    setConn(conns.find((c) => c.host.id === hostId) ?? null);
    return connectionManager.onStatusChange((updated) => {
      setConn(updated.find((c) => c.host.id === hostId) ?? null);
    });
  }, [hostId]);

  useEffect(() => {
    if (!conn || conn.status.kind !== "connected") {
      setTerminalStatus("offline");
      return;
    }

    let mounted = true;
    let openedSessionId: string | null = null;
    setTerminalStatus("opening");
    setTerminalError(null);

    const openTerminal = async () => {
      try {
        const session = await conn.client.terminal.open({
          threadId: terminalThreadId,
          terminalId: MOBILE_TERMINAL_ID,
          cwd: cwd ?? ".",
          cols: 80,
          rows: 24,
        });
        if (mounted) {
          openedSessionId = session.terminalId ?? MOBILE_TERMINAL_ID;
          setSessionId(openedSessionId);
          setTerminalStatus("open");
          setOutput((prev) => [...prev, "--- Terminal session opened ---"]);
        }
      } catch (err) {
        if (mounted) {
          const message = formatErrorMessage(err);
          setTerminalStatus("error");
          setTerminalError(message);
          setOutput((prev) => [...prev, `Failed to open terminal: ${message}`]);
        }
      }
    };

    void openTerminal();

    const unsub = conn.client.terminal.onEvent((event: unknown) => {
      if (!mounted) return;
      const ev = event as {
        data?: string;
        terminalId?: string;
        threadId?: string;
        type?: string;
      };
      if (
        ev.threadId !== terminalThreadId ||
        (ev.terminalId && ev.terminalId !== (openedSessionId ?? MOBILE_TERMINAL_ID))
      ) {
        return;
      }
      if (ev.data) {
        setOutput((prev) => [...prev, ev.data!]);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
      }
    });

    return () => {
      mounted = false;
      unsub();
      if (openedSessionId) {
        void conn.client.terminal.close({
          threadId: terminalThreadId,
          terminalId: openedSessionId,
          deleteHistory: false,
        });
      }
    };
  }, [conn, cwd, openAttempt, terminalThreadId]);

  useEffect(() => {
    if (
      ranInitialCommand ||
      !initialCommand?.trim() ||
      !sessionId ||
      !conn ||
      conn.status.kind !== "connected" ||
      terminalStatus !== "open"
    ) {
      return;
    }

    setRanInitialCommand(true);
    const command = initialCommand.trim();
    setOutput((prev) => [...prev, `$ ${command}`]);
    void conn.client.terminal.write({
      threadId: terminalThreadId,
      terminalId: sessionId,
      data: `${command}\n`,
    });
  }, [conn, initialCommand, ranInitialCommand, sessionId, terminalStatus, terminalThreadId]);

  const handleSubmit = useCallback(async () => {
    if (
      !input.trim() ||
      !conn ||
      conn.status.kind !== "connected" ||
      !sessionId ||
      terminalStatus !== "open"
    ) {
      return;
    }

    const text = input;
    setInput("");
    setOutput((prev) => [...prev, `$ ${text}`]);

    try {
      await conn.client.terminal.write({
        threadId: terminalThreadId,
        terminalId: sessionId,
        data: text + "\n",
      });
    } catch (err) {
      setOutput((prev) => [...prev, `Error: ${formatErrorMessage(err)}`]);
    }
  }, [conn, input, sessionId, terminalStatus, terminalThreadId]);

  const retryOpen = useCallback(() => {
    setSessionId(null);
    setTerminalError(null);
    setTerminalStatus("idle");
    setOpenAttempt((current) => current + 1);
  }, []);

  const reconnectHost = useCallback(() => {
    if (!conn) {
      return;
    }
    setTerminalStatus("opening");
    void connectionManager.connect(conn.host, { forceReconnect: true }).catch((cause) => {
      setTerminalStatus("error");
      setTerminalError(formatErrorMessage(cause));
    });
  }, [conn]);

  const handleClearTerminal = useCallback(async () => {
    if (!conn || conn.status.kind !== "connected" || !sessionId || terminalStatus !== "open") {
      return;
    }

    setTerminalAction("clear");
    setTerminalError(null);
    try {
      await conn.client.terminal.clear({
        threadId: terminalThreadId,
        terminalId: sessionId,
      });
      setOutput([]);
    } catch (cause) {
      setTerminalError(formatErrorMessage(cause));
    } finally {
      setTerminalAction(null);
    }
  }, [conn, sessionId, terminalStatus, terminalThreadId]);

  const handleRestartTerminal = useCallback(async () => {
    if (!conn || conn.status.kind !== "connected" || !sessionId || terminalAction !== null) {
      return;
    }

    setTerminalAction("restart");
    setTerminalError(null);
    try {
      const session = await conn.client.terminal.restart({
        threadId: terminalThreadId,
        terminalId: sessionId,
        cwd: cwd ?? ".",
        cols: 80,
        rows: 24,
      });
      setSessionId(session.terminalId ?? sessionId);
      setRanInitialCommand(false);
      setTerminalStatus("open");
      setOutput(["--- Terminal session restarted ---"]);
    } catch (cause) {
      setTerminalStatus("error");
      setTerminalError(formatErrorMessage(cause));
    } finally {
      setTerminalAction(null);
    }
  }, [conn, cwd, sessionId, terminalAction, terminalThreadId]);

  const handleAttachTerminalContext = useCallback(() => {
    if (!threadId) {
      return;
    }

    const context = buildMobileTerminalContextFromOutput({
      chunks: output,
      terminalId: sessionId ?? MOBILE_TERMINAL_ID,
      terminalLabel: "Mobile terminal",
    });
    if (!context) {
      Alert.alert("No terminal output", "Run a command before attaching terminal context.");
      return;
    }

    addThreadContext(threadId, context);
    Alert.alert(
      "Terminal context attached",
      "Recent terminal output will be included with your next message.",
    );
  }, [addThreadContext, output, sessionId, threadId]);

  const inputDisabled = terminalStatus !== "open" || !input.trim();
  const attachDisabled = !threadId || !hasMobileTerminalContextOutput(output);
  const terminalControlsDisabled = terminalStatus !== "open" || terminalAction !== null;

  return (
    <View style={[styles.root, { backgroundColor: termBg }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: "Terminal",
          headerStyle: { backgroundColor: termBg },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: termFg },
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
            <Text style={[styles.placeholder, { color: "#555" }]}>
              Terminal session. Type a command below.
            </Text>
          ) : (
            outputEntries.map(({ key, line }) => (
              <Text key={key} style={[styles.outputLine, { color: termFg }]}>
                {line}
              </Text>
            ))
          )}
        </ScrollView>

        {terminalStatus !== "open" ? (
          <View style={[styles.statusPanel, { backgroundColor: termBarBg, borderColor: "#333" }]}>
            {terminalStatus === "opening" ? (
              <ActivityIndicator color={colors.primary} />
            ) : terminalStatus === "offline" ? (
              <WifiOff size={18} color="#f87171" strokeWidth={2.2} />
            ) : (
              <RefreshCw size={18} color={colors.primary} strokeWidth={2.2} />
            )}
            <View style={styles.statusCopy}>
              <Text style={[styles.statusTitle, { color: termFg }]}>
                {terminalStatus === "opening"
                  ? "Opening terminal"
                  : terminalStatus === "offline"
                    ? "Host offline"
                    : "Terminal unavailable"}
              </Text>
              <Text style={styles.statusBody} numberOfLines={2}>
                {terminalError ??
                  (terminalStatus === "offline"
                    ? "Reconnect the host before sending commands."
                    : "Waiting for the host terminal session.")}
              </Text>
            </View>
            <Pressable
              onPress={terminalStatus === "offline" ? reconnectHost : retryOpen}
              disabled={terminalStatus === "opening" || !conn}
              style={[
                styles.statusButton,
                {
                  backgroundColor:
                    terminalStatus === "opening" || !conn
                      ? "rgba(255,255,255,0.08)"
                      : colors.primary,
                },
              ]}
            >
              <Text
                style={[
                  styles.statusButtonText,
                  {
                    color:
                      terminalStatus === "opening" || !conn ? "#777" : colors.primaryForeground,
                  },
                ]}
              >
                {terminalStatus === "offline" ? "Reconnect" : "Retry"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {terminalStatus === "open" ? (
          <View style={[styles.actionBar, { backgroundColor: termBarBg, borderTopColor: "#333" }]}>
            <Pressable
              onPress={() => void handleClearTerminal()}
              disabled={terminalControlsDisabled}
              accessibilityRole="button"
              accessibilityLabel="Clear terminal"
              style={[
                styles.actionButton,
                {
                  backgroundColor: terminalControlsDisabled
                    ? "rgba(255,255,255,0.08)"
                    : "rgba(255,255,255,0.12)",
                },
              ]}
            >
              {terminalAction === "clear" ? (
                <ActivityIndicator color={termFg} />
              ) : (
                <Eraser
                  size={15}
                  color={terminalControlsDisabled ? "#555" : termFg}
                  strokeWidth={2.2}
                />
              )}
              <Text
                style={[styles.actionLabel, { color: terminalControlsDisabled ? "#666" : termFg }]}
              >
                Clear
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void handleRestartTerminal()}
              disabled={terminalControlsDisabled}
              accessibilityRole="button"
              accessibilityLabel="Restart terminal"
              style={[
                styles.actionButton,
                {
                  backgroundColor: terminalControlsDisabled
                    ? "rgba(255,255,255,0.08)"
                    : "rgba(255,255,255,0.12)",
                },
              ]}
            >
              {terminalAction === "restart" ? (
                <ActivityIndicator color={termFg} />
              ) : (
                <RotateCcw
                  size={15}
                  color={terminalControlsDisabled ? "#555" : termFg}
                  strokeWidth={2.2}
                />
              )}
              <Text
                style={[styles.actionLabel, { color: terminalControlsDisabled ? "#666" : termFg }]}
              >
                Restart
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View
          style={[
            styles.inputBar,
            {
              backgroundColor: termBarBg,
              borderTopColor: "#333",
              paddingBottom: insets.bottom + 8,
            },
          ]}
        >
          <Text style={styles.prompt}>$</Text>
          <Pressable
            onPress={handleAttachTerminalContext}
            disabled={attachDisabled}
            accessibilityRole="button"
            accessibilityLabel="Attach terminal output"
            style={[
              styles.attachBtn,
              {
                backgroundColor: attachDisabled
                  ? "rgba(255,255,255,0.08)"
                  : "rgba(255,255,255,0.14)",
              },
            ]}
          >
            <Paperclip size={15} color={attachDisabled ? "#555" : termFg} strokeWidth={2.2} />
          </Pressable>
          <TextInput
            style={[styles.textInput, { color: termFg }]}
            value={input}
            onChangeText={setInput}
            placeholder="Enter command…"
            placeholderTextColor="#555"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={() => void handleSubmit()}
          />
          <Pressable
            onPress={() => void handleSubmit()}
            disabled={inputDisabled}
            style={[
              styles.sendBtn,
              {
                backgroundColor: inputDisabled ? "rgba(255,255,255,0.08)" : colors.primary,
              },
            ]}
          >
            <CornerDownLeft size={16} color={inputDisabled ? "#555" : "#fff"} strokeWidth={2} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  outputScroll: { flex: 1 },
  placeholder: {
    fontSize: 14,
    fontFamily: MONO,
    paddingVertical: 20,
  },
  outputLine: {
    fontSize: 13,
    fontFamily: MONO,
    lineHeight: 20,
  },
  statusPanel: {
    marginHorizontal: 12,
    marginBottom: 8,
    minHeight: 66,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statusCopy: {
    flex: 1,
    minWidth: 0,
  },
  statusTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  statusBody: {
    marginTop: 3,
    color: "#8a8a8a",
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  statusButton: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  statusButtonText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "900",
  },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionButton: {
    minHeight: 36,
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  actionLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  prompt: {
    color: "#4ade80",
    fontSize: 15,
    fontFamily: MONO,
    fontWeight: "700",
  },
  textInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: MONO,
    paddingVertical: 10,
  },
  attachBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
});
