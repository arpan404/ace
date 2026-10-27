import { InteractionId } from "@ace/protocol";
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

/** The `interaction.resolve` payload that answers an approval. */
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
  const gate = startup.runtimeForMutation(hostId);
  return gate.command(buildApprovalResolvePayload(interactionId, optionId));
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
  const gate = startup.runtimeForMutation(hostId);
  return gate.command(buildQuestionResolvePayload(interactionId, answers, dismissed));
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

/** True when the strip owns this request: pending approval or question. */
export function isCardableProductionInteraction(
  interaction: Pick<CardableInteraction, "state" | "request"> | undefined,
): boolean {
  if (interaction === undefined) return false;
  if (interaction.state !== "pending") return false;
  return interaction.request.kind === "approval" || interaction.request.kind === "question";
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
 * Whether the transcript's read-only question/approval row must stay hidden
 * because the live strip already shows the full card. Only pending
 * approval/question ids the strip covers suppress; resolved rows, other
 * request kinds and uncovered ids keep their historic read-only copy so
 * nothing vanishes.
 */
export function shouldSuppressProductionReadOnly(
  interaction: Pick<CardableInteraction, "id" | "state" | "request"> | undefined,
  covered: ReadonlySet<string>,
): boolean {
  if (!isCardableProductionInteraction(interaction)) return false;
  if (interaction === undefined) return false;
  return covered.has(interaction.id);
}

/**
 * Tap-time admission with a freshly read grant. Render-time `acting` drives
 * only the button's enabled state; every tap re-reads `canOperate(hostId)`
 * and checks here so a grant revoked after mount still refuses before
 * touching the lock or the wire.
 */
export function canTapProductionCard(
  state: string,
  locked: boolean,
  canOperateNow: boolean,
): boolean {
  return canResolveInteraction(state, locked, productionMayAct(canOperateNow) && mayAct(true));
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
