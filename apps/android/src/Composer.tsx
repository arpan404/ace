import { useMemo, useRef, useEffect, useLayoutEffect, useState } from "react";
import { TextInput, View, Text, findNodeHandle } from "react-native";
import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { AceHost, useTheme, tokens, textStyle } from "./theme.tsx";
import {
  fontEvidence,
  commitInput,
  watchInput,
  stopInputMetrics,
  inputMetrics,
} from "./input-metrics.ts";
import { ComposerDraft } from "./composer-draft.ts";
import { useSelection } from "./selection.ts";
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
  const [inputHeight, setInputHeight] = useState<number>(tokens.dimensions.touchTarget);
  const model = useMemo(
    () =>
      new ComposerDraft((text) =>
        client.enqueue({
          type: "thread.send",
          threadId: ThreadId.parse(threadId),
          input: [{ type: "text", text }],
          delivery: "steer",
        }),
      ),
    [client, threadId],
  );
  const { text: draft, saving } = useSelection(model.selection);
  useLayoutEffect(() => {
    void commitInput(draft.length);
    if (__DEV__ && draft.length > 0 && draft.length % 20 === 0) {
      void Promise.all([inputMetrics(), fontEvidence()])
        .then(([m, font]) => {
          console.info("AceSpikeMetrics", JSON.stringify({ input: m, font }));
        })
        .catch(() => console.info("AceSpikeMetrics unavailable"));
    }
  }, [draft]);
  async function send() {
    try {
      if ((await model.send()) === "saved")
        notify(client.state === "ready" ? "Message saved" : "Will send when reconnected");
    } catch {
      notify("Message could not be saved. Your draft is still here.");
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
          if (tag !== null)
            void watchInput(tag).catch(() => notify("Input measurement is unavailable"));
        }}
        onContentSizeChange={(event) =>
          setInputHeight(
            Math.max(
              tokens.dimensions.touchTarget,
              Math.min(
                tokens.typography.typeScale.body.lineHeight * 6,
                event.nativeEvent.contentSize.height,
              ),
            ),
          )
        }
        accessibilityLabel="Message"
        placeholder="Steer the agent…"
        selectionColor={theme.colours.accent}
        cursorColor={theme.colours.accent}
        underlineColorAndroid="transparent"
        placeholderTextColor={theme.colours.mutedForeground}
        multiline
        value={draft}
        onChangeText={(text) => model.edit(text)}
        style={{
          ...textStyle("body"),
          color: theme.colours.foreground,
          minHeight: tokens.dimensions.touchTarget,
          height: inputHeight,
          textAlignVertical: "top",
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
                void Promise.all([inputMetrics(), fontEvidence()])
                  .then(([m, font]) => {
                    console.info("AceSpikeMetrics", JSON.stringify({ input: m, font }));
                    notify(`${m.samples} edits · p95 ${m.p95Ms.toFixed(1)} ms end to end`);
                  })
                  .catch(() => notify("Focus the composer before measuring"));
              }}
            />
            <AceButton label="↑" onPress={() => void send()} enabled={!!draft.trim() && !saving} />
          </Row>
        </AceHost>
      </View>
    </View>
  );
}
