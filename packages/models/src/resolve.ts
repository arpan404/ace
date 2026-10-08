export { isDefaultSelection } from "./catalog-cleanup.ts";
import { isDefaultSelection, matchesModel } from "./catalog-cleanup.ts";
import { ModelRoleSpec, type CatalogModel, type ModelResolution } from "@ace/protocol";

export function resolveModel(
  input: ModelRoleSpec,
  models: Iterable<CatalogModel>,
  stale: (instance: string) => boolean,
): ModelResolution {
  const spec = ModelRoleSpec.parse(input);
  if (isDefaultSelection(spec.model)) delete spec.model;
  const ranks = new Map<string, number>();
  for (const [index, id] of spec.preferenceOrder.entries())
    if (!ranks.has(id)) ranks.set(id, index);
  let first: CatalogModel | undefined;
  let defaultModel: CatalogModel | undefined;
  let preferred: CatalogModel | undefined;
  let bestRank = Infinity;
  for (const model of models) {
    if (model.providerEnabled === false) continue;
    if (
      (spec.provider !== undefined && model.provider !== spec.provider) ||
      (spec.instance !== undefined && model.instance !== spec.instance)
    )
      continue;
    if (spec.model) {
      if (!matchesModel(model, spec.model)) continue;
    } else if (
      (model.deprecated || model.legacy || model.hidden) &&
      !(model.isDefault && model.defaultSource === "user")
    )
      continue;
    if (spec.imageInput && !model.inputModalities.includes("image")) continue;
    if (spec.effort && !model.reasoningEfforts.includes(spec.effort)) continue;
    if (
      spec.tier &&
      !model.serviceTiers.some(
        (tier) => tier.id === spec.tier || (spec.tier === "fast" && tier.speed === "fast"),
      )
    )
      continue;
    first ??= model;
    if (model.isDefault) defaultModel ??= model;
    const rank = ranks.get(model.id) ?? Infinity;
    if (spec.selection === "strongest" && rank < bestRank) {
      preferred = model;
      bestRank = rank;
    }
    if (
      (spec.selection === "strongest" && bestRank === 0) ||
      (spec.selection === "default" && defaultModel)
    )
      break;
  }
  const chosen = preferred ?? defaultModel ?? first;
  if (!chosen)
    return { ok: false, reason: `${spec.role}: no available model satisfies the policy` };
  const tier = chosen.serviceTiers.find((option) =>
    spec.tier
      ? option.id === spec.tier || (spec.tier === "fast" && option.speed === "fast")
      : option.id === chosen.defaultTier,
  );
  const effort =
    spec.effort ??
    (chosen.defaultEffort && chosen.reasoningEfforts.includes(chosen.defaultEffort)
      ? chosen.defaultEffort
      : undefined);
  const basis = spec.model
    ? "explicit model"
    : preferred
      ? "highest available policy preference"
      : spec.selection === "strongest"
        ? spec.preferenceOrder.length
          ? "preferred models unavailable; using provider default or first compatible model"
          : "strength order unavailable; using provider default or first compatible model"
        : "provider default or first compatible model";
  return {
    ok: true,
    model: chosen,
    ...(tier ? { tier } : {}),
    ...(effort ? { effort } : {}),
    stale: stale(chosen.instance),
    reason:
      `${spec.role}: ${basis}; ${chosen.id}${tier ? `, tier ${tier.id}` : ""}${effort ? `, effort ${effort}` : ""}`.slice(
        0,
        1024,
      ),
  };
}
