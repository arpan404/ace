import { useState, useRef, useEffect } from "react";
import { TextInput, View, Text, findNodeHandle } from "react-native";
import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { AceHost, useTheme, tokens, textStyle } from "./theme.tsx";
import { watchInput, stopInputMetrics, inputMetrics } from "./input-metrics.ts";
import { AceButton, Row } from "./components.tsx";
export function Composer({
  threadId,
  client,
  notify,
}: {
  threadId: string;
  client: ClientApi;
  notify(text: string): void;
}) {
  const input = useRef<TextInput>(null);
  useEffect(
    () => () => {
      void stopInputMetrics();
    },
    [],
  );
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  async function send() {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      await client.enqueue({
        type: "thread.send",
        threadId: ThreadId.parse(threadId),
        input: [{ type: "text", text: draft }],
        delivery: "steer",
      });
      setDraft("");
      notify(client.state === "ready" ? "Message saved" : "Will send when reconnected");
    } catch {
      notify("Message could not be saved. Your draft is still here.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <View
      style={{
        marginHorizontal: tokens.dimensions.composerInset,
        marginVertical: tokens.spacing.sm,
        padding: tokens.spacing.md,
        backgroundColor: theme.colours.card,
        borderRadius: tokens.radii.composer,
        borderWidth: tokens.dimensions.border,
        borderColor: theme.colours.separator,
        elevation: tokens.elevation.floating,
      }}
    >
      <TextInput
        ref={input}
        onFocus={() => {
          const tag = findNodeHandle(input.current);
          if (tag !== null) void watchInput(tag);
        }}
        accessibilityLabel="Message"
        placeholder="Steer the agent…"
        placeholderTextColor={theme.colours.mutedForeground}
        multiline
        value={draft}
        onChangeText={setDraft}
        style={{
          ...textStyle("body"),
          color: theme.colours.foreground,
          minHeight: tokens.dimensions.touchTarget,
          maxHeight: 160,
          padding: 0,
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
          Steer · queues if unavailable
        </Text>
        <AceHost>
          <Row>
            <AceButton
              label="Metrics"
              kind="secondary"
              onPress={() => {
                void inputMetrics().then((m) =>
                  notify(`${m.samples} edits · p95 ${m.p95Ms.toFixed(1)} ms to draw`),
                );
              }}
            />
            <AceButton label="↑" onPress={() => void send()} enabled={!!draft.trim() && !saving} />
          </Row>
        </AceHost>
      </View>
    </View>
  );
}
