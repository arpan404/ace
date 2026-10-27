import { InteractionId } from "@ace/protocol";
import { consentUrl, elicitationContent, elicitationForm } from "@ace/ui-core";
import { ViewOnlyError, type ProductionStartup } from "../runtime/production-startup.ts";
import { canResolveInteraction, mayAct, refusalMessage } from "../interactions.ts";

/**
 * Production approval and question resolution through the per-machine
 * mutation gate.
 *
 * Mirrors the iOS production answer path (`ClientModel.approve` /
 * `ClientModel.answer`: `guard canOperate` on every submission, one
 * in-flight submission per interaction, daemon refusals final) over the
 * existing Android pieces: `interactions.ts` owns the remount-safe locks
 * (`markResolutionSending/Sent/Refused`, first answer wins, refusals never
 * retry) plus the view-only and pending gates (`mayAct`,
 * `canResolveInteraction`), and `startup.runtimeForMutation(hostId)` owns
 * admission. The UI holds no gate, lease or raw `ClientApi`: every resolve
 * below names the machine plus the interaction and resolves a fresh gate
 * inside the call, so a grant revoked after the card mounted still fails
 * closed immediately before touching the wire.
 *
 * Contract: the existing `interaction.resolve` command with an approval or
 * question resolution, exactly like the fixture cards send. No iOS, daemon
 * or shared-contract edits.
 *
 * Read path stays view-only: cards render while pending regardless of the
 * grant; only sending is gated. The daemon re-enforces the grant.
 */

/** Narrowest startup surface the cards need: mutation admission only. */
export type ProductionApprovalsStartup = Pick<
  ProductionStartup,
  "runtimeForMutation" | "canOperate"
>;

/** The `interaction.resolve` payload that answers an approval.
 *
 * Throws synchronously on a malformed id (programming error from a
 * ledger-owned id): callers validate before locking so a bad id never
 * masquerades as a retryable transport failure. */
export function buildApprovalResolvePayload(
  interactionId: string,
  optionId: string,
): {
  type: "interaction.resolve";
  interactionId: ReturnType<typeof InteractionId.parse>;
  resolution: { kind: "approval"; optionId: string };
} {
  return {
    type: "interaction.resolve",
    interactionId: InteractionId.parse(interactionId),
    resolution: { kind: "approval", optionId },
  };
}

/** The `interaction.resolve` payload that answers (or skips) questions. */
export function buildQuestionResolvePayload(
  interactionId: string,
  answers: Record<string, string[]>,
  dismissed?: true | undefined,
): {
  type: "interaction.resolve";
  interactionId: ReturnType<typeof InteractionId.parse>;
  resolution: { kind: "question"; answers: Record<string, string[]>; dismissed?: true };
} {
  return {
    type: "interaction.resolve",
    interactionId: InteractionId.parse(interactionId),
    resolution:
      dismissed === true ? { kind: "question", answers, dismissed } : { kind: "question", answers },
  };
}

/**
 * Admit one approval answer through a freshly resolved gate. The gate is
 * local to this call and discarded after: nothing is cached, so revocation,
 * disconnect or removal between renders still fails here, immediately
 * before the mutation. Resolves to the daemon receipt, like the fixture
 * card's `client.command(...).then(receipt)`.
 */
export async function resolveProductionApproval(
  startup: ProductionApprovalsStartup,
  hostId: string,
  interactionId: string,
  optionId: string,
): Promise<{ ok: boolean; error?: string | undefined }> {
  // Validate input before resolving admission: a malformed id fails before
  // the gate is touched, so it never reads as a granted-then-failed send.
  const payload = buildApprovalResolvePayload(interactionId, optionId);
  const gate = startup.runtimeForMutation(hostId);
  return gate.command(payload);
}

/**
 * Admit one question answer (or skip) through a freshly resolved gate.
 * Same per-call admission as approvals: no cached gate, no raw client.
 */
export async function resolveProductionQuestion(
  startup: ProductionApprovalsStartup,
  hostId: string,
  interactionId: string,
  answers: Record<string, string[]>,
  dismissed?: true | undefined,
): Promise<{ ok: boolean; error?: string | undefined }> {
  // Same input-before-admission order as approvals: malformed ids fail
  // before the gate resolves, never as a transport retry.
  const payload = buildQuestionResolvePayload(interactionId, answers, dismissed);
  const gate = startup.runtimeForMutation(hostId);
  return gate.command(payload);
}

/** Plan markdown/todo bounds, mirroring the iOS request bridge. */
export const PLAN_MARKDOWN_LIMIT = 8192;
export const PLAN_TODO_LIMIT = 32;

export type PlanReviewDecision = "approve" | "reject" | "cancel";

/**
 * The canonical `plan_review` resolution for a card choice, or undefined
 * when the choice does not fit the request: a rejection must say what
 * should change (mirrors iOS `requestResolution`). Pure so the card can
 * enable Send only when the daemon would accept it.
 */
export function planReviewResolution(
  decision: PlanReviewDecision,
  feedback?: string | undefined,
): { kind: "plan_review"; decision: PlanReviewDecision; feedback?: string } | undefined {
  if (decision !== "reject") return { kind: "plan_review", decision };
  const trimmed = feedback?.trim() ?? "";
  return trimmed ? { kind: "plan_review", decision, feedback: trimmed } : undefined;
}

/** The `interaction.resolve` payload that answers a plan review. */
export function buildPlanReviewResolvePayload(
  interactionId: string,
  decision: PlanReviewDecision,
  feedback?: string | undefined,
): {
  type: "interaction.resolve";
  interactionId: ReturnType<typeof InteractionId.parse>;
  resolution: { kind: "plan_review"; decision: PlanReviewDecision; feedback?: string };
} {
  const resolution = planReviewResolution(decision, feedback);
  if (!resolution) throw new Error("Plan feedback must say what should change.");
  return {
    type: "interaction.resolve",
    interactionId: InteractionId.parse(interactionId),
    resolution,
  };
}

/**
 * Admit one plan-review answer through a freshly resolved gate. Same
 * per-call admission as approvals: input validated before the gate is
 * touched, so a choice the daemon would refuse never reaches the wire.
 */
export async function resolveProductionPlanReview(
  startup: ProductionApprovalsStartup,
  hostId: string,
  interactionId: string,
  decision: PlanReviewDecision,
  feedback?: string | undefined,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const payload = buildPlanReviewResolvePayload(interactionId, decision, feedback);
  const gate = startup.runtimeForMutation(hostId);
  return gate.command(payload);
}

export type ElicitationAction = "accept" | "decline" | "cancel";
/** Elicitation request shape the cards answer; optionals admit `undefined` under exact optionals. */
export interface ElicitationRequest {
  kind: "elicitation";
  server: string;
  message: string;
  url?: string | undefined;
  schema?: unknown;
  mode?: "form" | "url" | undefined;
}

/** Whether the elicitation draws its form or its consent page. */
export function elicitationMode(request: Pick<ElicitationRequest, "mode" | "url">): "form" | "url" {
  return request.mode ?? (request.url ? "url" : "form");
}

/**
 * The tappable consent address for a url-mode elicitation, when it is safe
 * to open: http(s) with no credentials (shared `consentUrl`, like the iOS
 * card's link destination). Anything else stays undefined so the card never
 * hands an unsafe address to the browser.
 */
export function consentLink(request: Pick<ElicitationRequest, "url">): string | undefined {
  return consentUrl(request.url);
}

/** Screen copy when the consent page cannot be opened; opening never throws. */
export const consentLinkFailureCopy = "That consent page could not be opened.";

/**
 * Open a url-mode elicitation's consent page through the transcript's
 * web-link opener, failing visibly. Unsafe addresses never reach the opener
 * (the card already tells the person to decline those); a refused open
 * notifies instead of throwing. Opening is a read, never a resolution: it
 * holds no lock and needs no grant, so view-only phones open it too. Pure
 * apart from the injected opener/notify, so tests pin it without a browser.
 */
export async function openConsentPage(
  request: Pick<ElicitationRequest, "url">,
  open: (url: string) => Promise<boolean>,
  notify: (text: string) => void,
): Promise<boolean> {
  const url = consentLink(request);
  if (!url) return false;
  try {
    const opened = await open(url);
    if (!opened) notify(consentLinkFailureCopy);
    return opened;
  } catch {
    notify(consentLinkFailureCopy);
    return false;
  }
}

/** Whether the card can only decline/cancel: no drawable form, no safe page. */
export function elicitationUnsupported(request: ElicitationRequest): boolean {
  const mode = elicitationMode(request);
  return mode === "url"
    ? consentUrl(request.url) === undefined
    : elicitationForm(request.schema) === undefined;
}

/** Trimmed non-empty values the card submits; mirrors the iOS card. */
export function submittedElicitationValues(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (trimmed) result[key] = trimmed;
  }
  return result;
}

/**
 * The canonical `elicitation` resolution for a card choice, or undefined
 * when the choice does not fit the request: accept needs values that pass
 * the server's schema (form) or a safe consent address (url); decline and
 * cancel always fit. Mirrors iOS `requestResolution`.
 */
export function elicitationResolution(
  request: ElicitationRequest,
  action: ElicitationAction,
  values?: Readonly<Record<string, string>> | undefined,
): { kind: "elicitation"; action: ElicitationAction; content?: unknown } | undefined {
  if (action !== "accept") return { kind: "elicitation", action };
  const mode = elicitationMode(request);
  if (mode === "url") {
    return consentUrl(request.url) ? { kind: "elicitation", action: "accept" } : undefined;
  }
  const form = elicitationForm(request.schema);
  if (!form) return undefined;
  const submitted = submittedElicitationValues(values ?? {});
  if (Object.keys(submitted).some((key) => !(key in form.properties))) return undefined;
  const result = elicitationContent(form, submitted);
  return result.valid
    ? { kind: "elicitation", action: "accept", content: result.content }
    : undefined;
}

/** The `interaction.resolve` payload that answers an elicitation. */
export function buildElicitationResolvePayload(
  interactionId: string,
  request: ElicitationRequest,
  action: ElicitationAction,
  values?: Readonly<Record<string, string>> | undefined,
): {
  type: "interaction.resolve";
  interactionId: ReturnType<typeof InteractionId.parse>;
  resolution: { kind: "elicitation"; action: ElicitationAction; content?: unknown };
} {
  const resolution = elicitationResolution(request, action, values);
  if (!resolution) throw new Error("This form answer does not fit the request.");
  return {
    type: "interaction.resolve",
    interactionId: InteractionId.parse(interactionId),
    resolution,
  };
}

/**
 * Admit one elicitation answer through a freshly resolved gate. Same
 * per-call admission as approvals: validated before the gate resolves.
 */
export async function resolveProductionElicitation(
  startup: ProductionApprovalsStartup,
  hostId: string,
  interactionId: string,
  request: ElicitationRequest,
  action: ElicitationAction,
  values?: Readonly<Record<string, string>> | undefined,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const payload = buildElicitationResolvePayload(interactionId, request, action, values);
  const gate = startup.runtimeForMutation(hostId);
  return gate.command(payload);
}

/**
 * Whether this device may answer production cards now. Unknown or
 * view-only grants fail closed: the card reads view-only until a pairing
 * records operate. Never default true; mirrors `mayAct`.
 */
export function productionMayAct(canOperate: boolean): boolean {
  return canOperate === true;
}

/** Screen copy for a thrown production answer failure (receipt refusals stay with `refusalMessage`). */
export function productionAnswerFailureCopy(error: unknown): string {
  if (error instanceof ViewOnlyError) return error.message;
  if (error instanceof Error && /not connected/i.test(error.message)) {
    return "This machine is not connected.";
  }
  return "Answer could not be saved.";
}

/** Name a daemon refusal for a plan-review answer; never invite a retry. */
export function productionPlanRefusalCopy(error: string | undefined): string {
  return refusalMessage(error, "This plan could not be answered");
}

/** Name a daemon refusal for an elicitation answer; never invite a retry. */
export function productionElicitationRefusalCopy(error: string | undefined): string {
  return refusalMessage(error, "This request could not be answered");
}

/** Name a daemon refusal for an approval answer; never invite a retry. */
export function productionApprovalRefusalCopy(error: string | undefined): string {
  return refusalMessage(error, "This approval could not be answered");
}

/** Name a daemon refusal for a question answer; never invite a retry. */
export function productionQuestionRefusalCopy(error: string | undefined): string {
  return refusalMessage(error, "These questions could not be answered");
}

/** Minimal interaction shape the strip needs: pending plus its request kind. */
export interface CardableInteraction {
  id: string;
  state: string;
  request: { kind: string };
}

/**
 * True when the strip owns this request: pending approval, question,
 * plan review or elicitation.
 *
 * Scope note: iOS `requestCard` also answers `browser_help` (done/skipped
 * in a browser tab). That needs a live browser surface plus its resolution
 * shape and stays out of scope: Android leaves it as a read-only
 * transcript row (never suppressed, never answered) until a matching card
 * exists. Extending without the matching UI would risk answering the wrong
 * semantics, so the gap stays pinned by tests.
 */
export function isCardableProductionInteraction(
  interaction: Pick<CardableInteraction, "state" | "request"> | undefined,
): boolean {
  if (interaction === undefined) return false;
  if (interaction.state !== "pending") return false;
  return (
    interaction.request.kind === "approval" ||
    interaction.request.kind === "question" ||
    interaction.request.kind === "plan_review" ||
    interaction.request.kind === "elicitation"
  );
}

/**
 * Pending approval/question ids for the strip, in ledger order, deduped.
 * Pure: the hook below feeds it live selections; tests pin revoke/stale
 * filtering without a daemon.
 */
export function pendingProductionInteractionIds(
  interactions: readonly (CardableInteraction | undefined)[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const interaction of interactions) {
    if (!isCardableProductionInteraction(interaction)) continue;
    const id = (interaction as CardableInteraction).id;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Whether the transcript's read-only question/approval/plan/form row must
 * stay hidden because the live strip already shows the full card. Only
 * pending cardable ids the strip covers suppress; resolved rows, other
 * request kinds and uncovered ids keep their historic read-only copy so
 * nothing vanishes.
 */
export function shouldSuppressProductionReadOnly(
  interaction: Pick<CardableInteraction, "id" | "state" | "request"> | undefined,
  covered: ReadonlySet<string>,
): boolean {
  if (interaction === undefined) return false;
  if (!isCardableProductionInteraction(interaction)) return false;
  return covered.has(interaction.id);
}

/**
 * Tap-time admission with a freshly read grant. Render-time `acting` drives
 * only the button's enabled state; every tap re-reads `canOperate(hostId)`
 * and checks here so a grant revoked after mount still refuses before
 * touching the lock or the wire. Callers must also pass a freshly re-read
 * interaction state (see `freshProductionInteractionState`): a daemon close
 * between render and tap must not send even when the grant still holds.
 */
export function canTapProductionCard(
  state: string,
  locked: boolean,
  canOperateNow: boolean,
): boolean {
  return canResolveInteraction(state, locked, productionMayAct(canOperateNow) && mayAct(true));
}

/**
 * Re-read one interaction's state at tap time, fail-closed. Render-time
 * `interaction.state` goes stale when the daemon closes the request between
 * render and tap; reading `store.interaction(id)?.state` inside the tap
 * closes that race so nothing reaches the wire for a resolved/cancelled/
 * expired/evicted request. A dead pin (throw) or a missing row reads as
 * undefined so the tap refuses without locking. Only `pending` admits.
 */
export function freshProductionInteractionState(
  store: {
    interaction(id: string): { state: string } | undefined;
  },
  interactionId: string,
): string | undefined {
  try {
    return store.interaction(interactionId)?.state;
  } catch {
    return undefined;
  }
}

/**
 * Whether a tap may proceed on a freshly re-read interaction. Missing rows
 * (undefined state) and non-pending states refuse without locking or wire.
 * Pure so tests pin the stale-render race without a daemon.
 */
export function canTapFreshProductionCard(
  freshState: string | undefined,
  locked: boolean,
  canOperateNow: boolean,
): boolean {
  if (freshState === undefined) return false;
  return canTapProductionCard(freshState, locked, canOperateNow);
}

/** Read the current grant fail-closed: unknown hosts and throws read view-only. */
export function currentProductionGrant(
  canOperate: (hostId: string) => boolean,
  hostId: string,
): boolean {
  try {
    return canOperate(hostId) === true;
  } catch {
    return false;
  }
}
