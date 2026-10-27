import { useEffect, useMemo } from "react";
import { AppState, Text, TextInput, View } from "react-native";
import { AceHost, tokens, textStyle, useTheme } from "../theme.tsx";
import { ComposerDraft, type DraftStore } from "../composer-draft.ts";
import { draftKey } from "../thread-drafts.ts";
import { useSelection } from "../selection.ts";
import { AceButton, Row } from "../components.tsx";
import { resolveComposerSubmitBehavior, shouldSubmitOnReturn } from "../composer-submit.ts";
import {
  productionSavedCopy,
  productionSendFailureCopy,
  sendProductionMessage,
  type ProductionComposerStartup,
} from "./production-composer.ts";

/**
 * Production thread composer: the fixture composer's editing state and draft
 * durability, with sends admitted through the per-machine mutation gate.
 *
 * Grant and host isolation: the draft key scopes words to one machine plus
 * thread (`draftKey(hostId, threadId)`), and every send resolves a fresh
 * `startup.runtimeForMutation(hostId)` inside the submit port — the component
 * holds no gate, no lease and never the raw `ClientApi`, so revocation lands
 * immediately before the mutation and view-only phones admit nothing. A
 * refused send keeps its draft durably, like iOS ("Your draft is still
 * available").
 *
 * No probe, metrics or fixture transports: production fails closed to plain
 * composing. Multiline by default; `returnSends` opts into Return-to-send,
 * mirroring iOS ⌘↩.
 */
export function ProductionComposer({
  startup,
  hostId,
  threadId,
  drafts,
  notify,
  returnSends = false,
}: {
  startup: ProductionComposerStartup & {
    runtimeForReading(hostId: string): { connectionState(): { getSnapshot(): string } };
  };
  hostId: string;
  threadId: string;
  /** Durable per-thread words; null keeps them only on screen. */
  drafts: DraftStore | null;
  notify(text: string): void;
  returnSends?: boolean;
}) {
  const theme = useTheme();
  const model = useMemo(
    () =>
      new ComposerDraft(async (text) => {
        await sendProductionMessage(startup, hostId, threadId, text);
      }),
    [startup, hostId, threadId],
  );
  const key = useMemo(() => draftKey(hostId, threadId), [hostId, threadId]);
  // Leaving the thread, backgrounding, or unmounting keeps the unsent words:
  // follow loads this thread's draft and flushes the one followed before.
  useEffect(() => {
    model.follow(key, drafts);
  }, [model, key, drafts]);
  useEffect(() => () => model.flush(), [model]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void model.flushAsync();
    });
    return () => subscription.remove();
  }, [model]);
  const { text: draft, saving } = useSelection(model.selection);

  async function send() {
    try {
      if ((await model.send()) === "saved") {
        let connection = "";
        try {
          connection = startup.runtimeForReading(hostId).connectionState().getSnapshot();
        } catch {
          connection = "";
        }
        notify(productionSavedCopy(connection));
      }
    } catch (error) {
      notify(productionSendFailureCopy(error));
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
        accessibilityLabel="Message"
        placeholder="Steer the agent…"
        selectionColor={theme.colours.accent}
        cursorColor={theme.colours.accent}
        underlineColorAndroid="transparent"
        placeholderTextColor={theme.colours.mutedForeground}
        multiline
        submitBehavior={resolveComposerSubmitBehavior(returnSends, false)}
        onSubmitEditing={shouldSubmitOnReturn(returnSends, false) ? () => void send() : undefined}
        value={draft}
        onChangeText={(next) => model.edit(next)}
        style={{
          ...textStyle("body"),
          color: theme.colours.foreground,
          minHeight: tokens.dimensions.touchTarget,
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
            <AceButton label="↑" onPress={() => void send()} enabled={!!draft.trim() && !saving} />
          </Row>
        </AceHost>
      </View>
    </View>
  );
}
