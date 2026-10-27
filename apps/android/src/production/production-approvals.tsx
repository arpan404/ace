import { useEffect, useMemo, useState } from "react";
import { TextInput } from "react-native";
import type { ThreadSource } from "@ace/client";
import { approvalCopy, questionOptions, type QuestionDraft as Draft } from "@ace/ui-core";
import { useSelection } from "../selection.ts";
import { AceHost, tokens, useTheme, textStyle } from "../theme.tsx";
import {
  AceText,
  AceButton,
  Column,
  Row,
  padding,
  background,
  clip,
  fillMaxWidth,
} from "../components.tsx";
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
  setOtherText,
  shellCommandForApproval,
  togglePick,
  useResolutionEntry,
  visibleQuestions,
} from "../interactions.ts";
import {
  productionAnswerFailureCopy,
  productionApprovalRefusalCopy,
  productionMayAct,
  productionQuestionRefusalCopy,
  resolveProductionApproval,
  resolveProductionQuestion,
  type ProductionApprovalsStartup,
} from "./production-approvals.ts";

/**
 * Production approval card: the fixture card's read and copy over the
 * read-only lease store, with answers admitted through the per-machine
 * mutation gate.
 *
 * Grant and host isolation: the component holds no gate, lease or raw
 * client. Acting reads `startup.canOperate(hostId)` per render (a boolean,
 * never a handle), and every tap resolves a fresh
 * `startup.runtimeForMutation(hostId)` inside the submit, so revocation
 * lands immediately before the mutation and view-only phones admit nothing.
 * Reads stay available while view-only; a revoked route must unmount this
 * card (the caller owns that, like the composer).
 *
 * Remount/double-send semantics come from `interactions.ts`: the module
 * lock survives remounts (first tap wins), an accepted answer stays shut,
 * a daemon refusal names the refusal and never retries, and only a
 * transport failure clears the lock so the pending card may try again.
 */
export function ProductionApprovalCard({
  startup,
  hostId,
  store,
  interactionId,
  notify,
}: {
  startup: ProductionApprovalsStartup;
  hostId: string;
  /** Read-only thread view from the reading lease; never a mutating handle. */
  store: ThreadSource;
  interactionId: string;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () => store.select([`interaction:${interactionId}`], (r) => r.interaction(interactionId)),
    [store, interactionId],
  );
  const interaction = useSelection(selection);
  const toolCallSelection = useMemo(() => {
    const toolCallId = interaction?.toolCallId ?? "";
    return store.select([`item:${toolCallId}`], (r) => r.item(toolCallId));
  }, [store, interaction?.toolCallId]);
  const toolCall = useSelection(toolCallSelection);
  const resolution = useResolutionEntry(interactionId);
  const [details, setDetails] = useState(false);
  const state = interaction?.state;
  useEffect(() => {
    if (interaction && state !== "pending") clearClosedResolution(interaction.id);
  }, [interaction, state]);
  if (!interaction || state !== "pending" || interaction.request.kind !== "approval") return null;
  const request = interaction.request;
  const command = shellCommandForApproval(toolCall);
  const copy = approvalCopy(request, command !== undefined ? { command } : {});
  const acting = productionMayAct(startup.canOperate(hostId)) && mayAct(true);
  const locked = isResolutionLocked(interaction.id);
  const answerable = canResolveInteraction(state, locked, acting);
  const refusal = resolution?.phase === "refused" ? resolution.message : undefined;
  const sending = resolution?.phase === "sending" || resolution?.phase === "sent";
  const hasDetails = copy.reason !== undefined || copy.others.length > 0;
  function resolve(optionId: string) {
    if (
      !interaction ||
      !canResolveInteraction(interaction.state, isResolutionLocked(interaction.id), acting)
    )
      return;
    markResolutionSending(interaction.id);
    void resolveProductionApproval(startup, hostId, interaction.id, optionId)
      .then((receipt) => {
        if (!interaction) return;
        if (receipt.ok) {
          markResolutionSent(interaction.id);
          notify("Answer accepted");
          // Keep locked until the daemon closes the interaction (first answer wins).
        } else {
          // A daemon refusal is final: stay shut instead of inviting a retry.
          const message = productionApprovalRefusalCopy(receipt.error);
          markResolutionRefused(interaction.id, message);
          notify(message);
        }
      })
      .catch((error: unknown) => {
        if (!interaction) return;
        clearResolutionSending(interaction.id);
        notify(productionAnswerFailureCopy(error));
      });
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
          Approval needed
        </AceText>
        <AceText role="title">{copy.heading}</AceText>
        {copy.command ? <AceText role="code">$ {copy.command}</AceText> : null}
        {copy.risk ? (
          <AceText
            role="caption"
            colour={
              copy.risk.level === "high" ? theme.statusText.failed : theme.statusText.needsYou
            }
          >
            {copy.risk.level === "high" ? "High risk" : "Medium risk"} · {copy.risk.text}
          </AceText>
        ) : null}
        {copy.facts.map((fact) => (
          <AceText key={fact.label} role="caption" colour={theme.colours.mutedForeground}>
            {fact.label}: {fact.value}
          </AceText>
        ))}
        {copy.code ? <AceText role="code">{copy.code}</AceText> : null}
        {copy.files.length > 0 ? (
          <Column verticalArrangement={{ spacedBy: tokens.spacing.sm }}>
            <AceText role="caption" colour={theme.colours.mutedForeground}>
              {copy.files.length === 1 ? "1 file" : `${copy.files.length} files`} · every file needs
              this approval
            </AceText>
            {copy.files.map((path) => (
              <AceText key={path} role="code">
                {path}
              </AceText>
            ))}
          </Column>
        ) : null}
        <Row horizontalArrangement={{ spacedBy: tokens.spacing.sm }}>
          {hasDetails ? (
            <AceButton
              label={details ? "Hide details" : "Details"}
              onPress={() => setDetails((open) => !open)}
              kind="secondary"
            />
          ) : null}
          {copy.decisions.map((decision) => (
            <AceButton
              key={decision.option.id}
              label={decision.scope ? `${decision.label}: ${decision.scope}` : decision.label}
              onPress={() => resolve(decision.option.id)}
              enabled={answerable}
              kind={decision.emphasis === "primary" ? "primary" : "secondary"}
            />
          ))}
        </Row>
        {details && copy.reason ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            {copy.reason}
          </AceText>
        ) : null}
        {details
          ? copy.others.map((other) => (
              <AceButton
                key={other.option.id}
                label={other.label}
                onPress={() => resolve(other.option.id)}
                enabled={answerable}
                kind="secondary"
              />
            ))
          : null}
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
        {sending ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            Sending…
          </AceText>
        ) : null}
      </Column>
    </AceHost>
  );
}

/**
 * Production question card: same read/admission split as the approval card.
 * Skip and Continue resolve through a fresh per-call gate; the draft stays
 * local and view-only phones read without answering.
 */
export function ProductionQuestionCard({
  startup,
  hostId,
  store,
  interactionId,
  notify,
}: {
  startup: ProductionApprovalsStartup;
  hostId: string;
  /** Read-only thread view from the reading lease; never a mutating handle. */
  store: ThreadSource;
  interactionId: string;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () => store.select([`interaction:${interactionId}`], (r) => r.interaction(interactionId)),
    [store, interactionId],
  );
  const interaction = useSelection(selection);
  const resolution = useResolutionEntry(interactionId);
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
  const acting = productionMayAct(startup.canOperate(hostId)) && mayAct(true);
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
    void resolveProductionQuestion(
      startup,
      hostId,
      interaction.id,
      resolutionValue.answers,
      resolutionValue.dismissed,
    )
      .then((receipt) => {
        if (!interaction) return;
        if (receipt.ok) {
          markResolutionSent(interaction.id);
          notify(resolutionValue.dismissed ? "Questions skipped" : "Answer accepted");
        } else {
          // A daemon refusal is final: stay shut instead of inviting a retry.
          const message = productionQuestionRefusalCopy(receipt.error);
          markResolutionRefused(interaction.id, message);
          notify(message);
        }
      })
      .catch((error: unknown) => {
        if (!interaction) return;
        clearResolutionSending(interaction.id);
        notify(productionAnswerFailureCopy(error));
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

/**
 * Every pending production interaction above the composer: one approval or
 * question card per open request, mirroring the fixture thread's strip and
 * the iOS request strip above the composer. Read-only rows render while
 * view-only; sending stays behind the per-call mutation gate inside each
 * card. The caller mounts this beside (not inside) the transcript list so
 * transcript rendering stays untouched.
 *
 * Not mounted in `ProductionThreadView` yet: this slice lands the cards and
 * their admission, and the strip wiring follows once the open-thread review
 * settles, to keep this change conflict-free.
 */
export function ProductionInteractionStrip({
  startup,
  hostId,
  store,
  interactionIds,
  notify,
}: {
  startup: ProductionApprovalsStartup;
  hostId: string;
  /** Read-only thread view from the reading lease; never a mutating handle. */
  store: ThreadSource;
  interactionIds: readonly string[];
  notify(text: string): void;
}) {
  return (
    <>
      {interactionIds.map((id) => (
        <ProductionApprovalCard
          key={`approval:${id}`}
          startup={startup}
          hostId={hostId}
          store={store}
          interactionId={id}
          notify={notify}
        />
      ))}
      {interactionIds.map((id) => (
        <ProductionQuestionCard
          key={`question:${id}`}
          startup={startup}
          hostId={hostId}
          store={store}
          interactionId={id}
          notify={notify}
        />
      ))}
    </>
  );
}
