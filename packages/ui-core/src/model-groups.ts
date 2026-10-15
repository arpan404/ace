import { accountDisplayName, type AccountView } from "./accounts.ts";
import type {
  ModelDiscoveryError,
  ModelInstanceStatus,
  ModelSource,
  ProviderKind,
} from "@ace/protocol";
import type { PickerModel } from "./model-picker.ts";

/*
 * A provider's models as its picker tab and Settings list them: grouped by where they come from
 * (each account, local runtimes, a subscription, an API key), current models in the catalog's
 * order with older ones apart, and each group's freshness and discovery errors beside it.
 */

/** Why a group's list may be out of date, and what to do about it, in the daemon's words. */
export interface ModelProblem {
  severity?: "info" | "warning" | undefined;
  actionId?: "provider.sign_in" | undefined;
  message: string;
  hint: string;
  /** The daemon's category, which says whether signing in fixes it. */
  code?: ModelDiscoveryError["code"] | undefined;
  /** The source the problem is about (an OpenCode or Pi upstream such as "opencode-go"). */
  source?: string | undefined;
  /** About one source rather than the whole account, so other sources may still list models. */
  partial?: true | undefined;
}

export interface PickerGroup {
  /** Stable across reads: the instance and the source group. */
  id: string;
  provider: ProviderKind;
  /** "OpenCode Go", "Local", "Work"; Zen keeps its header even as the sole group. */
  label: string | undefined;
  /** Current models, in `sortKey` order. */
  current: PickerModel[];
  /** Older and deprecated models, for the group's Legacy models section. */
  legacy: PickerModel[];
  /** Discovery is running for this group; its last list shows meanwhile. */
  refreshing: boolean;
  /** Errors from its last refresh; its last good models still list. */
  problems: ModelProblem[];
}

/**
 * Group order: local runtimes, then subscriptions (OpenCode Go), the OpenCode Zen gateway, the
 * person's own API keys, other configured providers; accounts in the catalog's order.
 */
function rank(source: ModelSource | undefined): number {
  if (!source || source.kind === "account") return 5;
  if (source.kind === "local") return 0;
  if (source.kind === "subscription") return 1;
  if (source.service === "opencode_zen") return 2;
  return source.kind === "api_key" ? 3 : 4;
}

/** Local runtimes share one "Local" group; every other source is a group of its own. */
function groupKey(instance: string, source: ModelSource | undefined): string {
  if (!source || source.kind === "account") return instance;
  return `${instance}\u0000${source.kind === "local" ? "local" : source.id}`;
}

function groupLabel(source: ModelSource | undefined): string {
  return source?.kind === "local" ? "Local" : (source?.label ?? "");
}

const vanishedId = "\u0000vanished";

/** What an old daemon's code-only error says, when it sends no message of its own. */
const unexplained: ModelProblem = {
  message: "Models couldn't be refreshed.",
  hint: "The last list is shown. Try Refresh models.",
};

const bySortKey = (a: PickerModel, b: PickerModel) =>
  a.sortKey !== undefined && b.sortKey !== undefined
    ? a.sortKey < b.sortKey
      ? -1
      : a.sortKey > b.sortKey
        ? 1
        : 0
    : 0;

/**
 * One provider's groups. A group with neither models nor an error is left out; one with an
 * error but no models still shows, so a failing source is never silent. Headers only when the
 * provider has more than one group, or the sole group is OpenCode Zen.
 */
export function pickerGroups(
  models: readonly PickerModel[],
  statuses: readonly ModelInstanceStatus[],
  provider: ProviderKind,
  accounts: readonly AccountView[] = [],
): PickerGroup[] {
  const names = new Map(accounts.map((account) => [account.id, accountDisplayName(account)]));
  const groups = new Map<string, PickerGroup & { rank: number; keys: Set<string> }>();
  // A saved choice the catalog no longer lists leads the list, so it is seen, not scrolled to.
  const vanishedGroup = () => {
    const found = groups.get(vanishedId) ?? {
      id: vanishedId,
      provider,
      label: undefined,
      current: [],
      legacy: [],
      refreshing: false,
      problems: [],
      rank: -1,
      keys: new Set<string>(),
    };
    groups.set(vanishedId, found);
    return found;
  };
  const group = (instance: string, source: ModelSource | undefined) => {
    const id = groupKey(instance, source);
    let found = groups.get(id);
    if (!found) {
      found = {
        id,
        provider,
        label:
          !source || source.kind === "account"
            ? (names.get(instance) ?? groupLabel(source))
            : groupLabel(source),
        current: [],
        legacy: [],
        refreshing: false,
        problems: [],
        rank: rank(source),
        keys: new Set(),
      };
      groups.set(id, found);
    }
    return found;
  };
  for (const model of models) {
    if (model.provider !== provider) continue;
    const into = model.vanished ? vanishedGroup() : group(model.instance ?? "", model.source);
    if (into.keys.has(model.key)) continue;
    into.keys.add(model.key);
    (model.legacy ? into.legacy : into.current).push(model);
  }
  const report = (
    into: PickerGroup,
    problem: ModelProblem | undefined,
    source?: ModelSource | undefined,
    partial?: true,
  ) => {
    if (problem && !into.problems.some((known) => known.message === problem.message))
      into.problems.push({
        message: problem.message,
        hint: problem.hint,
        ...(problem.code ? { code: problem.code } : {}),
        ...(source && source.kind !== "local" && source.kind !== "account"
          ? { source: source.id }
          : {}),
        ...(problem.actionId ? { actionId: problem.actionId } : {}),
        ...(partial ? { partial } : {}),
        ...(problem.code === "no_models" || problem.code === "not_configured"
          ? { severity: "info" as const }
          : {}),
      });
  };
  for (const status of statuses) {
    if (status.provider !== provider) continue;
    for (const entry of status.sources ?? []) {
      // A failing source with no models still gets its group, to say why.
      const listed = groups.has(groupKey(status.instance, entry.source));
      if (!listed && !entry.error) continue;
      const into = group(status.instance, entry.source);
      into.refreshing ||= entry.status === "refreshing";
      report(into, entry.error, entry.source, true);
    }
    const whole = status.errorDetail ?? (status.error ? unexplained : undefined);
    const refreshing = status.status === "refreshing" || status.refreshing;
    const own = [...groups.values()].filter(
      (entry) => entry.id.split("\u0000")[0] === status.instance,
    );
    if (!own.length && whole) own.push(group(status.instance, status.sources?.[0]?.source));
    for (const into of own) {
      into.refreshing ||= refreshing;
      report(into, whole);
    }
  }
  const listed = [...groups.values()]
    .filter((entry) => entry.current.length || entry.legacy.length || entry.problems.length)
    .toSorted((a, b) =>
      a.rank !== b.rank
        ? a.rank - b.rank
        : a.rank === 5
          ? 0
          : (a.label ?? "").localeCompare(b.label ?? ""),
    );
  return listed.map((entry) => ({
    id: entry.id,
    provider,
    label: listed.length > 1 || entry.rank === 2 ? entry.label || undefined : undefined,
    current: entry.current.toSorted(bySortKey),
    legacy: entry.legacy.toSorted(bySortKey),
    refreshing: entry.refreshing,
    problems: entry.problems,
  }));
}

/** Providers with a discovery error to show, whose tab stays open even without models. */
export function providersWithProblems(
  statuses: readonly ModelInstanceStatus[],
): ReadonlySet<ProviderKind> {
  return new Set(
    statuses
      .filter(
        (status) =>
          status.errorDetail || status.error || status.sources?.some((entry) => entry.error),
      )
      .map((status) => status.provider),
  );
}

/**
 * A picker tab's models as one list: every source's current models (a saved model the catalog
 * lost still first), then one Legacy section. Rows name their own source, so there are no source
 * headers. A source that failed says nothing while another source still lists models; a sole
 * source, or one beside sources with nothing, says why. A problem with the whole account
 * (its sign-in expired) always shows: the models listed won't run until it is fixed.
 */
export function pickerSection(groups: readonly PickerGroup[]): PickerGroup | undefined {
  const [first] = groups;
  if (!first) return undefined;
  const lists = (group: PickerGroup) => group.current.length + group.legacy.length > 0;
  const seen = new Set<string>();
  const problems = groups.flatMap((group) =>
    group.problems.filter((problem) => {
      // Another source still lists models: this one's failure is not worth a warning.
      const quiet = problem.partial && groups.some((other) => other !== group && lists(other));
      if (quiet || seen.has(problem.message)) return false;
      seen.add(problem.message);
      return true;
    }),
  );
  return {
    id: first.id,
    provider: first.provider,
    label: undefined,
    current: groups.flatMap((group) => group.current),
    legacy: groups.flatMap((group) => group.legacy),
    refreshing: groups.some((group) => group.refreshing),
    problems,
  };
}
