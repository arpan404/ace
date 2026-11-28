import { useMemo, useRef, useEffect, useLayoutEffect, useState } from "react";
import { AppState, TextInput, View, Text, findNodeHandle } from "react-native";
import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { AceHost, useTheme, tokens, textStyle } from "./theme.tsx";
import {
  fontEvidence,
  commitInput,
  watchInput,
  stopInputMetrics,
  inputMetrics,
  probeInput,
} from "./input-metrics.ts";
import { isInstrumentedBuild } from "./native-mode.ts";
import { ComposerDraft, type DraftStore } from "./composer-draft.ts";
import { useSelection } from "./selection.ts";
import { AceButton, Row } from "./components.tsx";
import { resolveComposerSubmitBehavior, shouldSubmitOnReturn } from "./composer-submit.ts";
export function Composer({
  threadId,
  draftKey,
  drafts,
  client,
  notify,
  returnSends = false,
}: {
  threadId: string;
  /** Where this composer's unsent words are kept; null keeps them only on screen. */
  draftKey: string | null;
  drafts: DraftStore | null;
  client: ClientApi;
  notify(text: string): void;
  returnSends?: boolean;
}) {
  const input = useRef<TextInput>(null);
  // Probe and metrics exist only in fixture builds; production fails closed to plain composing.
  const instrumented = useMemo(() => isInstrumentedBuild(), []);
  useEffect(
    () => () => {
      if (instrumented) void stopInputMetrics().catch(() => undefined);
    },
    [instrumented],
  );
  const theme = useTheme();
  const [inputHeight, setInputHeight] = useState<number>(tokens.dimensions.touchTarget);
  const [probing, setProbing] = useState(false);
  const probeActive = useRef(false);
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
  // Leaving the thread, backgrounding, or a killed app keeps the unsent words:
  // follow loads this thread's draft and flushes the one followed before.
  // Backgrounding awaits the write to give it its best chance, but the OS can
  // still kill the app mid-write: drafts are exact across navigation and
  // relaunch, best-effort across kills.
  useEffect(() => {
    model.follow(draftKey, drafts);
  }, [model, draftKey, drafts]);
  useEffect(() => () => model.flush(), [model]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void model.flushAsync();
    });
    return () => subscription.remove();
  }, [model]);
  const { text: draft, saving } = useSelection(model.selection);
  useLayoutEffect(() => {
    if (!instrumented) return;
    void commitInput(draft.length);
    if (draft.length > 0 && draft.length % 20 === 0) {
      void Promise.all([inputMetrics(), fontEvidence()])
        .then(([m, font]) => {
          console.info("AceSpikeMetrics", JSON.stringify({ input: m, font }));
        })
        .catch(() => console.info("AceSpikeMetrics unavailable"));
    }
  }, [draft, instrumented]);
  async function send() {
    try {
      if ((await model.send()) === "saved")
        notify(client.state === "ready" ? "Message saved" : "Will send when reconnected");
    } catch {
      notify("Message could not be saved. Your draft is still here.");
    }
  }
  async function measure() {
    if (!instrumented || probeActive.current) return;
    probeActive.current = true;
    console.info("AceSpikeProbe started");
    setProbing(true);
    try {
      const [m, font] = await Promise.all([probeInput(), fontEvidence()]);
      console.info("AceSpikeMetrics", JSON.stringify({ input: m, font }));
      notify(`${m.samples} edits · p95 ${m.p95Ms.toFixed(1)} ms end to end`);
    } catch (error: unknown) {
      console.info(
        "AceSpikeProbe failed",
        error instanceof Error ? error.message : "Native probe rejected",
      );
      notify("Input coverage was incomplete. Focus the composer first.");
    } finally {
      probeActive.current = false;
      setProbing(false);
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
          if (!instrumented) return;
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
        submitBehavior={resolveComposerSubmitBehavior(returnSends, instrumented)}
        onSubmitEditing={
          instrumented
            ? () => void measure()
            : shouldSubmitOnReturn(returnSends, instrumented)
              ? () => void send()
              : undefined
        }
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
        <Text
          style={{
            ...textStyle("caption"),
            color: theme.colours.mutedForeground,
            flex: 1,
            paddingRight: tokens.spacing.sm,
          }}
        >
          Steer · queues if unavailable
        </Text>
        <AceHost>
          <Row>
            {instrumented ? (
              <AceButton
                label="Probe"
                kind="secondary"
                enabled={!probing}
                onPress={() => void measure()}
              />
            ) : null}
            <AceButton label="↑" onPress={() => void send()} enabled={!!draft.trim() && !saving} />
          </Row>
        </AceHost>
      </View>
    </View>
  );
}
