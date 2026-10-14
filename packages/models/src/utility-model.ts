import type { CatalogModel, ProviderKind, ProviderStatus, UtilityModelChoice } from "@ace/protocol";
import { executionModelId } from "./execution-id.ts";

/** What ace runs a short generation on: the catalog row's launch id, account and effort. */
export interface UtilityModel {
  provider: ProviderKind;
  /** The catalog id, as the person's choice names it. */
  model: string;
  /** The id the CLI launches with (OpenCode's `provider/model`). */
  launchModel: string;
  instance?: string;
  effort?: string;
  /** The person chose it, rather than the ready-provider default. */
  chosen: boolean;
}

/** What resolution reads from a provider's status: whether it's enabled and signed in. */
export type UtilityStatus = Pick<ProviderStatus, "provider" | "enabled" | "readiness">;
type Matcher = (model: CatalogModel) => boolean;
const named =
  (pattern: RegExp): Matcher =>
  (model) =>
    pattern.test(model.id) || pattern.test(model.nativeModelId);
const free: Matcher = (model) => model.free === true;
const small = named(/(?:^|[-/._ ])(?:mini|nano|flash|lite|haiku|luna|fast)(?:$|[-/._ ])/i);

/**
 * The default when the person hasn't chosen: providers in this order, each with its cheap/fast
 * models most-preferred first. The catalog has no price signal beyond OpenCode's `free`, so
 * this table is the one place the choice is made. ACP agents have no one-shot mode and aren't
 * listed.
 */
export const utilityFallbacks: readonly { provider: ProviderKind; picks: readonly Matcher[] }[] = [
  { provider: "codex", picks: [(model) => model.id === "gpt-6-luna", named(/luna/i)] },
  { provider: "claude", picks: [named(/haiku/i)] },
  { provider: "opencode", picks: [free, small] },
  { provider: "cursor", picks: [named(/composer/i), small] },
  { provider: "pi", picks: [free, small] },
];
/** The providers ace can run a one-shot generation on. */
export const utilityProviders: readonly ProviderKind[] = utilityFallbacks.map(
  (entry) => entry.provider,
);

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** The lowest effort the model takes (its native id), or none when it has no effort choice. */
export function lowestEffort(model: Pick<CatalogModel, "efforts">): string | undefined {
  let best: { id: string; rank: number } | undefined;
  for (const effort of model.efforts) {
    const rank = effort.level ? effortOrder.indexOf(effort.level) : -1;
    if (rank >= 0 && (best === undefined || rank < best.rank)) best = { id: effort.id, rank };
  }
  return best?.id ?? model.efforts[0]?.id;
}

/** The providers the daemon reports installed, enabled and signed in. */
export function readyProviders(statuses: readonly UtilityStatus[]): ProviderKind[] {
  return statuses
    .filter((status) => status.enabled !== false && status.readiness === "signed_in")
    .map((status) => status.provider);
}
function usable(model: CatalogModel): boolean {
  return !model.deprecated && model.providerEnabled !== false;
}
function utility(model: CatalogModel, chosen: boolean, effort?: string): UtilityModel {
  const lowest = effort ?? lowestEffort(model);
  return {
    provider: model.provider,
    model: model.id,
    launchModel: executionModelId(model),
    instance: model.instance,
    ...(lowest ? { effort: lowest } : {}),
    chosen,
  };
}

/**
 * The model for titles and commit/PR drafts. The person's choice wins while its provider is
 * ready; otherwise the first ready provider in `utilityFallbacks` whose account offers one of
 * its picks. A provider without such a model steps to the next. Undefined means no generation:
 * titles stay the first words of the message and commit messages are written by hand.
 */
export function resolveUtilityModel(input: {
  choice: UtilityModelChoice | null | undefined;
  /** Providers installed, enabled and signed in. */
  ready: readonly ProviderKind[];
  models: readonly CatalogModel[];
}): UtilityModel | undefined {
  const { choice, ready, models } = input;
  if (choice && ready.includes(choice.provider) && utilityProviders.includes(choice.provider)) {
    const row = models.find(
      (model) =>
        model.provider === choice.provider &&
        model.id === choice.model &&
        (choice.instance === undefined || model.instance === choice.instance),
    );
    if (row) return utility(row, true, choice.effort);
    return {
      provider: choice.provider,
      model: choice.model,
      launchModel: choice.model,
      ...(choice.instance ? { instance: choice.instance } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
      chosen: true,
    };
  }
  for (const { provider, picks } of utilityFallbacks) {
    if (!ready.includes(provider)) continue;
    const offered = models.filter((model) => model.provider === provider && usable(model));
    for (const pick of picks) {
      const matches = offered.filter(pick);
      const found = matches.find((model) => !model.legacy) ?? matches[0];
      if (found) return utility(found, false);
    }
  }
  return undefined;
}
