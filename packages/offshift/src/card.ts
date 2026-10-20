import {
  OffshiftRunCard,
  type OffshiftCardCriterion,
  type OffshiftEvidenceState,
  type OffshiftRun,
} from "@ace/protocol/offshift";

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
 */
export function runCard(run: OffshiftRun, revision: string): OffshiftRunCard {
  const pending: OffshiftRunCard["pending"] = [];
  const criteria: OffshiftCardCriterion[] = [];
  for (const criterion of run.criteria) {
    const evidence = [...new Set(criterion.requiredKinds)].map((kind) => {
      const found = run.evidence.find(
        (item) => item.criterionId === criterion.id && item.kind === kind,
      );
      const state: OffshiftEvidenceState = !found
        ? "missing"
        : found.revision !== revision
          ? "stale"
          : found.result;
      if (state !== "pass") pending.push({ criterionId: criterion.id, kind });
      return { kind, state, recordedAt: found?.recordedAt ?? null };
    });
    if (criteria.length < 16)
      criteria.push({ id: criterion.id, description: clip(criterion.description, 160), evidence });
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
  });
}
