import { useEffect, useMemo, useState } from "react";
import { TextInput } from "react-native";
import type { ClientApi, ThreadSource } from "@ace/client";
import { questionOptions, type QuestionDraft as Draft } from "@ace/ui-core";
import { useSelection } from "./selection.ts";
import { AceHost, tokens, useTheme, textStyle } from "./theme.tsx";
import {
  AceText,
  AceButton,
  Column,
  Row,
  padding,
  background,
  clip,
  fillMaxWidth,
} from "./components.tsx";
import {
  canContinue,
  canResolveInteraction,
  clearClosedResolution,
  clearResolutionSending,
  completeAnswers,
  currentQuestionIndex,
  dismissedResolution,
  emptyQuestionDraft,
  isResolutionLocked,
  isUnanswerable,
  markResolutionRefused,
  markResolutionSending,
  markResolutionSent,
  mayAct,
  questionResolution,
  refusalMessage,
  setOtherText,
  togglePick,
  useResolutionEntry,
  visibleQuestions,
} from "./interactions.ts";

export function Questions({
  id,
  store,
  client,
  notify,
  canAct,
}: {
  id: string;
  store: ThreadSource;
  client: ClientApi;
  notify(text: string): void;
  /** This device may answer. Absent fails closed to view-only; never default true. */
  canAct?: boolean | undefined;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () => store.select([`interaction:${id}`], (r) => r.interaction(id)),
    [store, id],
  );
  const interaction = useSelection(selection);
  const resolution = useResolutionEntry(id);
  const [draft, setDraft] = useState<Draft>(emptyQuestionDraft);
  const state = interaction?.state;
  useEffect(() => {
    if (interaction && state !== "pending") clearClosedResolution(interaction.id);
  }, [interaction, state]);
  if (!interaction || state !== "pending" || interaction.request.kind !== "question") return null;
  const questions = interaction.request.questions;
  const shown = visibleQuestions(questions);
  const capped = isUnanswerable(questions);
  const index = currentQuestionIndex(draft.at, shown.length);
  const current = shown[index];
  const acting = mayAct(canAct);
  const locked = isResolutionLocked(interaction.id);
  const answerable = canResolveInteraction(state, locked, acting);
  const refusal = resolution?.phase === "refused" ? resolution.message : undefined;
  const sending = resolution?.phase === "sending" || resolution?.phase === "sent";
  const ready = current ? canContinue(current, draft) : false;

  function send(
    resolutionValue:
      | { kind: "question"; answers: Record<string, string[]>; dismissed?: true }
      | undefined,
  ) {
    if (
      !resolutionValue ||
      !interaction ||
      !canResolveInteraction(interaction.state, isResolutionLocked(interaction.id), acting)
    )
      return;
    markResolutionSending(interaction.id);
    if (client.state !== "ready") notify("Will apply when reconnected");
    void client
      .command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: resolutionValue,
      })
      .then((receipt) => {
        if (!interaction) return;
        if (receipt.ok) {
          markResolutionSent(interaction.id);
          notify(resolutionValue.dismissed ? "Questions skipped" : "Answer accepted");
        } else {
          // A daemon refusal is final: stay shut instead of inviting a retry.
          const message = refusalMessage(receipt.error, "These questions could not be answered");
          markResolutionRefused(interaction.id, message);
          notify(message);
        }
      })
      .catch(() => {
        if (!interaction) return;
        clearResolutionSending(interaction.id);
        notify("Answer could not be saved");
      });
  }

  function answer() {
    if (capped) return;
    const resolutionValue = questionResolution(questions, draft);
    send(resolutionValue);
  }

  function skip() {
    send(dismissedResolution());
  }

  return (
    <AceHost style={{ width: "100%" }}>
      <Column
        modifiers={[
          fillMaxWidth(),
          clip({ type: "roundedCorner", radius: tokens.radii.approval }),
          background(theme.colours.card),
          padding(tokens.spacing.lg, tokens.spacing.lg, tokens.spacing.lg, tokens.spacing.lg),
        ]}
        verticalArrangement={{ spacedBy: tokens.spacing.md }}
      >
        <AceText role="label" colour={theme.statusText.needsYou}>
          Question
        </AceText>
        {current ? (
          <>
            <AceText role="title">{current.text}</AceText>
            {current.header || shown.length > 1 ? (
              <AceText role="caption" colour={theme.colours.mutedForeground}>
                {[current.header, shown.length > 1 ? `${index + 1} of ${shown.length}` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </AceText>
            ) : null}
            <Column verticalArrangement={{ spacedBy: tokens.spacing.sm }}>
              {questionOptions(current).map((option) => {
                const chosen = (draft.picked[current.id] ?? []).includes(option.id);
                return (
                  <AceButton
                    key={option.id}
                    label={`${chosen ? "✓ " : ""}${option.label}${option.recommended ? " (Recommended)" : ""}`}
                    onPress={() => setDraft((prev) => togglePick(prev, current, option.id))}
                    enabled={answerable && !capped}
                    kind={chosen ? "primary" : "secondary"}
                  />
                );
              })}
              {current.allowOther ? (
                <TextInput
                  accessibilityLabel={`Other answer for ${current.id}`}
                  placeholder="Something else…"
                  secureTextEntry={current.secret}
                  editable={answerable && !capped}
                  value={draft.texts[current.id] ?? ""}
                  onChangeText={(text) => setDraft((prev) => setOtherText(prev, current, text))}
                  multiline
                  style={{
                    ...textStyle("body"),
                    color: theme.colours.foreground,
                    backgroundColor: theme.colours.secondaryBackground,
                    borderRadius: tokens.radii.bubble,
                    padding: tokens.spacing.md,
                    minHeight: tokens.dimensions.touchTarget,
                  }}
                />
              ) : null}
            </Column>
          </>
        ) : null}
        {capped ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            This question has more choices than fit here. Answer it on your machine.
          </AceText>
        ) : null}
        {!acting ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            View only. Pair with View and act to answer.
          </AceText>
        ) : null}
        {refusal ? (
          <AceText role="caption" colour={theme.statusText.failed}>
            {refusal}
          </AceText>
        ) : null}
        <Row horizontalArrangement={{ spacedBy: tokens.spacing.sm }}>
          <AceButton
            label={shown.length > 1 ? "Skip these questions" : "Skip this question"}
            onPress={skip}
            enabled={answerable}
            kind="secondary"
          />
          {!capped ? (
            index < shown.length - 1 ? (
              <AceButton
                label="Next"
                onPress={() => setDraft((prev) => ({ ...prev, at: index + 1 }))}
                enabled={answerable && ready}
                kind="primary"
              />
            ) : (
              <AceButton
                label="Continue"
                onPress={answer}
                enabled={answerable && completeAnswers(questions, draft) !== undefined}
                kind="primary"
              />
            )
          ) : null}
        </Row>
        {sending ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            Sending…
          </AceText>
        ) : null}
      </Column>
    </AceHost>
  );
}
