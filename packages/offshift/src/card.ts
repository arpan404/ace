import {
  OffshiftRunCard,
  type OffshiftCardCriterion,
  type OffshiftRun,
} from "@ace/protocol/offshift";
import { evidenceState } from "./workflow.ts";

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair; "…" marks a cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const point of text) {
    if (out.length + point.length > max - 1) break;
    out += point;
  }
  return `${out}…`;
}

/**
 * The bounded client card of a run as observed at `revision`. A pass recorded at another
 * revision is stale; evidence state is computed here because only the host knows the revision.
 * `next` is the view's next step at this write.
 */
export function runCard(run: OffshiftRun, revision: string, next?: string): OffshiftRunCard {
  const pending: OffshiftRunCard["pending"] = [];
  const criteria: OffshiftCardCriterion[] = [];
  for (const criterion of run.criteria) {
    const evidence = [...new Set(criterion.requiredKinds)].map((kind) => {
      const found = run.evidence.find(
        (item) => item.criterionId === criterion.id && item.kind === kind,
      );
      const state = evidenceState(run, criterion, found, revision);
      if (state === "not_independent")
        pending.push({ criterionId: criterion.id, kind, needs: "independent" });
      else if (state !== "pass") pending.push({ criterionId: criterion.id, kind });
      return {
        kind,
        state,
        recordedAt: found?.recordedAt ?? null,
        by: found?.by
          ? {
              provider: found.by.provider,
              model: found.by.model === null ? null : clip(found.by.model, 64),
            }
          : null,
      };
    });
    if (criteria.length < 16)
      criteria.push({
        id: criterion.id,
        description: clip(criterion.description, 160),
        independent: criterion.independent === true,
        evidence,
      });
  }
  const outcome = clip(run.outcome, 512);
  return OffshiftRunCard.parse({
    id: run.id,
    outcome,
    outcomeTruncated: outcome !== run.outcome,
    endpoint: clip(run.endpoint, 256),
    phase: run.phase,
    blocker: run.blocker === null ? null : clip(run.blocker, 512),
    version: run.version,
    updatedAt: run.updatedAt,
    revision,
    criteria,
    criteriaCount: run.criteria.length,
    pending: pending.slice(0, 16),
    pendingCount: pending.length,
    // The current phase only: what the person checks now, bounded by the run's 24 steps.
    steps: run.steps
      .filter((step) => step.phase === run.phase)
      .map((step) => ({
        id: step.id,
        title: step.title,
        state: step.state,
        reason: step.state === "skipped" && step.note ? clip(step.note, 160) : undefined,
      })),
    ...(run.playbook ? { playbook: run.playbook } : {}),
    ...(next ? { next: clip(next, 512) } : {}),
  });
}
