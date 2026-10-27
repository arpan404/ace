import { Fragment, useEffect, useMemo, useState } from "react";
import { TextInput } from "react-native";
import type { Selection, ThreadSource } from "@ace/client";
import type { Interaction } from "@ace/protocol";
import { approvalCopy, questionOptions, type QuestionDraft as Draft } from "@ace/ui-core";
import { consentUrl, elicitationForm } from "@ace/ui-core";
import { sameIds, useSelection } from "../selection.ts";
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
  canTapFreshProductionCard,
  canTapProductionCard,
  currentProductionGrant,
  elicitationMode,
  elicitationResolution,
  elicitationUnsupported,
  freshProductionInteractionState,
  isCardableProductionInteraction,
  pendingProductionInteractionIds,
  planReviewResolution,
  productionAnswerFailureCopy,
  productionApprovalRefusalCopy,
  productionElicitationRefusalCopy,
  productionMayAct,
  productionPlanRefusalCopy,
  productionQuestionRefusalCopy,
  resolveProductionApproval,
  resolveProductionElicitation,
  resolveProductionPlanReview,
  resolveProductionQuestion,
  submittedElicitationValues,
  PLAN_MARKDOWN_LIMIT,
  PLAN_TODO_LIMIT,
  type ElicitationAction,
  type PlanReviewDecision,
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
    if (!interaction) return;
    // Fresh reads at tap time: the grant may have been revoked and the
    // daemon may have closed the request since render. Either refuses
    // before the lock or the wire; a dead pin reads as undefined and fails
    // closed the same way.
    const freshGrant = currentProductionGrant((id) => startup.canOperate(id), hostId);
    const freshState = freshProductionInteractionState(store, interaction.id);
    if (!canTapFreshProductionCard(freshState, isResolutionLocked(interaction.id), freshGrant))
      return;
    // Belt and braces: the legacy grant-only check stays true whenever the
    // fresh-state check passes.
    if (!canTapProductionCard(interaction.state, isResolutionLocked(interaction.id), freshGrant))
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
    if (!resolutionValue || !interaction) return;
    const freshGrant = currentProductionGrant((id) => startup.canOperate(id), hostId);
    const freshState = freshProductionInteractionState(store, interaction.id);
    if (!canTapFreshProductionCard(freshState, isResolutionLocked(interaction.id), freshGrant))
      return;
    if (!canTapProductionCard(interaction.state, isResolutionLocked(interaction.id), freshGrant))
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
 * Production plan-review card: approve as is, or send back with what should
 * change. Same read/admission split as the approval card: the plan reads
 * while view-only, every tap re-reads the grant plus the live interaction
 * state and resolves through a fresh per-call gate.
 */
export function ProductionPlanReviewCard({
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
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const state = interaction?.state;
  useEffect(() => {
    if (interaction && state !== "pending") clearClosedResolution(interaction.id);
  }, [interaction, state]);
  if (!interaction || state !== "pending" || interaction.request.kind !== "plan_review")
    return null;
  const request = interaction.request;
  const markdown =
    request.markdown.length > PLAN_MARKDOWN_LIMIT
      ? request.markdown.slice(0, PLAN_MARKDOWN_LIMIT)
      : request.markdown;
  const truncated = request.markdown.length > PLAN_MARKDOWN_LIMIT;
  const todos = (request.todos ?? []).slice(0, PLAN_TODO_LIMIT);
  const acting = productionMayAct(startup.canOperate(hostId)) && mayAct(true);
  const locked = isResolutionLocked(interaction.id);
  const answerable = canResolveInteraction(state, locked, acting);
  const refusal = resolution?.phase === "refused" ? resolution.message : undefined;
  const sending = resolution?.phase === "sending" || resolution?.phase === "sent";
  const words = feedback.trim();
  function send(decision: PlanReviewDecision, text?: string) {
    if (!interaction) return;
    if (planReviewResolution(decision, text) === undefined) return;
    const freshGrant = currentProductionGrant((id) => startup.canOperate(id), hostId);
    const freshState = freshProductionInteractionState(store, interaction.id);
    if (!canTapFreshProductionCard(freshState, isResolutionLocked(interaction.id), freshGrant))
      return;
    if (!canTapProductionCard(interaction.state, isResolutionLocked(interaction.id), freshGrant))
      return;
    markResolutionSending(interaction.id);
    void resolveProductionPlanReview(startup, hostId, interaction.id, decision, text)
      .then((receipt) => {
        if (!interaction) return;
        if (receipt.ok) {
          markResolutionSent(interaction.id);
          notify(decision === "approve" ? "Plan approved" : "Feedback sent");
        } else {
          const message = productionPlanRefusalCopy(receipt.error);
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
          Plan review
        </AceText>
        <AceText role="title">{request.title ?? "Review the plan"}</AceText>
        {request.summary ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            {request.summary}
          </AceText>
        ) : null}
        <AceText role="body">{markdown}</AceText>
        {todos.map((todo) => (
          <AceText
            key={`${todo.status}:${todo.content}`}
            role="caption"
            colour={theme.colours.mutedForeground}
          >
            {todo.status === "completed" ? "✓ " : todo.status === "in_progress" ? "◐ " : "○ "}
            {todo.content}
          </AceText>
        ))}
        {truncated ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            The full plan is on your machine.
          </AceText>
        ) : null}
        {revising ? (
          <TextInput
            accessibilityLabel="What should change?"
            placeholder="What should change?"
            editable={answerable}
            value={feedback}
            onChangeText={setFeedback}
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
        <Row horizontalArrangement={{ spacedBy: tokens.spacing.sm }}>
          <AceButton
            label={revising ? "Cancel" : "Request changes"}
            onPress={() => setRevising((open) => !open)}
            enabled={answerable}
            kind="secondary"
          />
          {revising ? (
            <AceButton
              label="Send feedback"
              onPress={() => send("reject", words)}
              enabled={answerable && words.length > 0}
              kind="primary"
            />
          ) : (
            <AceButton
              label="Approve plan"
              onPress={() => send("approve")}
              enabled={answerable}
              kind="primary"
            />
          )}
        </Row>
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
 * Production elicitation card: an MCP server's form, or its consent page.
 * Values are typed as text; the shared schema rules decide whether accept
 * fits before anything reaches the wire. Decline and cancel always fit.
 */
export function ProductionElicitationCard({
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
  const [values, setValues] = useState<Record<string, string>>({});
  const state = interaction?.state;
  useEffect(() => {
    if (interaction && state !== "pending") clearClosedResolution(interaction.id);
  }, [interaction, state]);
  if (!interaction || state !== "pending" || interaction.request.kind !== "elicitation")
    return null;
  const request = interaction.request;
  const mode = elicitationMode(request);
  const unsupported = elicitationUnsupported(request);
  const form = mode === "form" ? elicitationForm(request.schema) : undefined;
  const fields = Object.entries(form?.properties ?? {}).map(([key, property]) => ({
    key,
    title: property.title ?? key,
    detail: property.description ?? "",
    type: property.type,
    required: form?.required.includes(key) ?? false,
    initial: property.default === undefined ? "" : String(property.default),
    choices:
      property.enum?.map((entry, at) => ({
        value: String(entry),
        label: property.enumNames?.[at] ?? String(entry),
      })) ??
      (property.type === "boolean"
        ? [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]
        : []),
  }));
  const submitted = submittedElicitationValues(
    Object.fromEntries(fields.map((field) => [field.key, values[field.key] ?? field.initial])),
  );
  const filled = fields.every((field) => !field.required || submitted[field.key] !== undefined);
  const acting = productionMayAct(startup.canOperate(hostId)) && mayAct(true);
  const locked = isResolutionLocked(interaction.id);
  const answerable = canResolveInteraction(state, locked, acting);
  const refusal = resolution?.phase === "refused" ? resolution.message : undefined;
  const sending = resolution?.phase === "sending" || resolution?.phase === "sent";
  function send(action: ElicitationAction) {
    if (!interaction) return;
    const current = Object.fromEntries(
      fields.map((field) => [field.key, values[field.key] ?? field.initial]),
    );
    if (elicitationResolution(request, action, current) === undefined) return;
    const freshGrant = currentProductionGrant((id) => startup.canOperate(id), hostId);
    const freshState = freshProductionInteractionState(store, interaction.id);
    if (!canTapFreshProductionCard(freshState, isResolutionLocked(interaction.id), freshGrant))
      return;
    if (!canTapProductionCard(interaction.state, isResolutionLocked(interaction.id), freshGrant))
      return;
    markResolutionSending(interaction.id);
    void resolveProductionElicitation(startup, hostId, interaction.id, request, action, current)
      .then((receipt) => {
        if (!interaction) return;
        if (receipt.ok) {
          markResolutionSent(interaction.id);
          notify(action === "accept" ? "Answer accepted" : "Request declined");
        } else {
          const message = productionElicitationRefusalCopy(receipt.error);
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
          {request.server}
        </AceText>
        <AceText role="title">{request.title ?? request.message}</AceText>
        {request.message !== (request.title ?? request.message) && request.message ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            {request.message}
          </AceText>
        ) : null}
        {unsupported ? (
          <AceText role="caption" colour={theme.statusText.failed}>
            {mode === "url"
              ? "This request has no safe consent page. Decline or cancel it."
              : "This form can't be filled in here. Decline or cancel it."}
          </AceText>
        ) : null}
        {mode === "url" && !unsupported ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            {consentUrl(request.url) ?? ""}
          </AceText>
        ) : null}
        <Column verticalArrangement={{ spacedBy: tokens.spacing.sm }}>
          {fields.map((field) => {
            const value = values[field.key] ?? field.initial;
            if (field.choices.length > 0) {
              return (
                <Column key={field.key} verticalArrangement={{ spacedBy: tokens.spacing.xs }}>
                  <AceText role="caption" colour={theme.colours.mutedForeground}>
                    {field.title}
                    {field.required ? " (Required)" : ""}
                  </AceText>
                  <Row horizontalArrangement={{ spacedBy: tokens.spacing.sm }}>
                    {field.choices.map((choice) => (
                      <AceButton
                        key={choice.value}
                        label={`${value === choice.value ? "✓ " : ""}${choice.label}`}
                        onPress={() =>
                          setValues((prev) => ({ ...prev, [field.key]: choice.value }))
                        }
                        enabled={answerable && !unsupported}
                        kind={value === choice.value ? "primary" : "secondary"}
                      />
                    ))}
                  </Row>
                </Column>
              );
            }
            return (
              <Column key={field.key} verticalArrangement={{ spacedBy: tokens.spacing.xs }}>
                <AceText role="caption" colour={theme.colours.mutedForeground}>
                  {field.title}
                  {field.required ? " (Required)" : ""}
                </AceText>
                <TextInput
                  accessibilityLabel={field.title}
                  placeholder={field.detail || (field.required ? "Required" : "Optional")}
                  editable={answerable && !unsupported}
                  value={value}
                  onChangeText={(text) => setValues((prev) => ({ ...prev, [field.key]: text }))}
                  keyboardType={
                    field.type === "integer"
                      ? "number-pad"
                      : field.type === "number"
                        ? "decimal-pad"
                        : "default"
                  }
                  multiline={field.type === "string"}
                  style={{
                    ...textStyle("body"),
                    color: theme.colours.foreground,
                    backgroundColor: theme.colours.secondaryBackground,
                    borderRadius: tokens.radii.bubble,
                    padding: tokens.spacing.md,
                    minHeight: tokens.dimensions.touchTarget,
                  }}
                />
              </Column>
            );
          })}
        </Column>
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
            label="Cancel"
            onPress={() => send("cancel")}
            enabled={answerable}
            kind="secondary"
          />
          <AceButton
            label="Decline"
            onPress={() => send("decline")}
            enabled={answerable}
            kind="secondary"
          />
          <AceButton
            label="Continue"
            onPress={() => send("accept")}
            enabled={answerable && !unsupported && filled}
            kind="primary"
          />
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
 * Every pending production interaction above the composer, in ledger order:
 * one approval, question, plan or form card per open request, mirroring the fixture
 * thread's per-id strip and the iOS request strip above the composer. A
 * single pass over `interactionIds` keeps ledger order (`[q1,a1]` renders
 * `[q1,a1]`); each card returns null for the kind it does not own, so no
 * cardable id renders twice and non-cardable ids render nothing here while
 * the transcript keeps their read-only row. Read-only rows render while
 * view-only; sending stays behind the per-call mutation gate inside each
 * card plus a fresh grant and fresh state recheck on every tap. The caller
 * mounts this beside (not inside) the transcript list so transcript
 * rendering stays untouched, and hides the transcript's read-only copy for
 * the same ids so the full card shows once. Mounted in
 * `ProductionThreadView`; a revoked route or host switch unmounts it with
 * the thread view, and view-only phones keep the full card details with
 * answering disabled.
 */
const EMPTY_PENDING_IDS: readonly string[] = Object.freeze([]);

function emptyPendingSelection(): Selection<readonly string[]> {
  return {
    getSnapshot: () => EMPTY_PENDING_IDS,
    subscribe: () => () => {},
  };
}

function emptyPendingInteractions(): Selection<readonly (Interaction | undefined)[]> {
  return {
    getSnapshot: () => EMPTY_PENDING_IDS as unknown as readonly (Interaction | undefined)[],
    subscribe: () => () => {},
  };
}

/**
 * Live pending approval/question/plan/form ids for the strip, in ledger order.
 * Two selections (membership plus one N-key read) mirror `useOpenQuestionIds`
 * but keep only the kinds the strip can answer; any pin failure, dead lease
 * or non-cardable request fails closed to empty so the strip unmounts instead
 * of crashing. Reads stay available while view-only; only taps gate.
 */
export function usePendingProductionInteractionIds(store: ThreadSource): readonly string[] {
  const idsSelection = useMemo(() => {
    try {
      return store.select(["interactions"], (r) => r.interactionIds(), sameIds);
    } catch {
      return null;
    }
  }, [store]);
  const fallbackIds = useMemo(() => emptyPendingSelection(), []);
  const safeIds = useMemo<Selection<readonly string[]>>(
    () => ({
      getSnapshot: () => {
        try {
          return (idsSelection ?? fallbackIds).getSnapshot();
        } catch {
          return EMPTY_PENDING_IDS;
        }
      },
      subscribe: (listener: () => void) => {
        try {
          return (idsSelection ?? fallbackIds).subscribe(listener);
        } catch {
          return () => {};
        }
      },
    }),
    [idsSelection, fallbackIds],
  );
  const ids = useSelection(safeIds);
  const key = ids.join("\0");
  const rowsSelection = useMemo(() => {
    try {
      return store.select(
        ids.map((id) => `interaction:${id}` as const),
        (r) =>
          ids.map((id) => {
            try {
              return r.interaction(id);
            } catch {
              return undefined;
            }
          }),
      );
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);
  const fallbackRows = useMemo(() => emptyPendingInteractions(), []);
  const safeRows = useMemo<Selection<readonly (Interaction | undefined)[]>>(
    () => ({
      getSnapshot: () => {
        try {
          return (rowsSelection ?? fallbackRows).getSnapshot();
        } catch {
          return EMPTY_PENDING_IDS as unknown as readonly (Interaction | undefined)[];
        }
      },
      subscribe: (listener: () => void) => {
        try {
          return (rowsSelection ?? fallbackRows).subscribe(listener);
        } catch {
          return () => {};
        }
      },
    }),
    [rowsSelection, fallbackRows],
  );
  const rows = useSelection(safeRows);
  return useMemo(
    () =>
      pendingProductionInteractionIds(
        rows.map((interaction) =>
          interaction === undefined
            ? undefined
            : {
                id: interaction.id,
                state: interaction.state,
                request: { kind: interaction.request.kind },
              },
        ),
      ),
    [rows],
  );
}

/**
 * Whether the transcript's read-only copy for one interaction is covered by
 * the live strip. Re-exported here so the thread view hides the duplicate
 * without reaching into card internals.
 */
export function isCoveredProductionInteraction(
  interaction: Interaction | undefined,
  covered: ReadonlySet<string>,
): boolean {
  return (
    isCardableProductionInteraction(
      interaction === undefined
        ? undefined
        : { state: interaction.state, request: { kind: interaction.request.kind } },
    ) && covered.has((interaction as Interaction).id)
  );
}

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
        <Fragment key={id}>
          <ProductionApprovalCard
            startup={startup}
            hostId={hostId}
            store={store}
            interactionId={id}
            notify={notify}
          />
          <ProductionQuestionCard
            startup={startup}
            hostId={hostId}
            store={store}
            interactionId={id}
            notify={notify}
          />
          <ProductionPlanReviewCard
            startup={startup}
            hostId={hostId}
            store={store}
            interactionId={id}
            notify={notify}
          />
          <ProductionElicitationCard
            startup={startup}
            hostId={hostId}
            store={store}
            interactionId={id}
            notify={notify}
          />
        </Fragment>
      ))}
    </>
  );
}
