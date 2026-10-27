import {
  AccessMode,
  type AgentModelRoster,
  type AgentModelsAccount,
  type AgentModelsProvider,
  type AgentModelsSet,
  type CatalogModel,
  type ProviderKind,
} from "@ace/protocol";
import { compareVersions, executionModelId, matchesModel, searchModels } from "@ace/models";
import { accountForName, type NamedAccount } from "./account-names.ts";

/** One account as the catalog reports it, already checked against the caller's access. */
export interface RosterAccount {
  provider: ProviderKind;
  accountId: string;
  accountLabel?: string | undefined;
  auth: "logged_in" | "logged_out" | "unknown";
  availability?: string | undefined;
  installed: boolean;
  enabled?: boolean | undefined;
  allowedAccessModes: readonly AccessMode[];
}
/** A catalog row and the account id `delegate` takes for the account that reported it. */
export interface RosterRow {
  model: CatalogModel;
  account: string;
}
export interface RosterInput {
  rows: readonly RosterRow[];
  accounts: readonly RosterAccount[];
  caller: { access: AccessMode | null; provider: ProviderKind; model?: string };
  query?: string | undefined;
  /** The accounts `delegate` resolves a name against; `accounts` and their labels when absent. */
  named?: readonly NamedAccount[] | undefined;
}

/** A provider lists at most this many models by default; the rest are one query away. */
export const defaultModelsPerProvider = 8;
/** A query returns at most this many models, nearest first. */
export const queryMatches = 10;

interface Merged {
  id: string;
  provider: ProviderKind;
  first: CatalogModel;
  accounts: string[];
  defaultOn: string[];
  legacy: boolean;
  /** Some account calls it superseded, so a newer release of its line exists there. */
  supersededSomewhere: boolean;
  pinned: boolean;
}

const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
/** A display name earns its place only when the id does not already spell it. */
const nameOf = (model: CatalogModel) =>
  plain(model.id).includes(plain(model.displayName)) ? undefined : model.displayName;
const effortsOf = (model: CatalogModel) => model.efforts.map((effort) => effort.id);
const runnable = (model: CatalogModel) => !model.hidden && !model.deprecated;
const isLegacy = (model: CatalogModel) =>
  model.tier === "legacy" || model.legacy === true || model.group === "legacy";
/** Releases of one line share a family; unrecognised names fall back to their versionless stem. */
const familyOf = (model: CatalogModel) =>
  model.family ?? model.id.slice(model.id.lastIndexOf("/") + 1).replace(/[-_.]?\d.*$/, "");

function callerModel(row: CatalogModel, caller: RosterInput["caller"]) {
  return (
    !!caller.model &&
    row.provider === caller.provider &&
    (executionModelId(row) === caller.model || matchesModel(row, caller.model))
  );
}

/**
 * One entry per model across every account that serves it. A model is legacy only when every
 * account that serves it calls it legacy: an account whose newest release it is still needs it.
 */
function merge(rows: readonly RosterRow[], caller: RosterInput["caller"]): Merged[] {
  const byModel = new Map<string, Merged>();
  for (const { model, account } of rows) {
    if (!runnable(model)) continue;
    const key = `${model.provider}\u0000${model.id}`;
    const entry: Merged = byModel.get(key) ?? {
      id: model.id,
      provider: model.provider,
      first: model,
      accounts: [],
      defaultOn: [],
      legacy: isLegacy(model),
      supersededSomewhere: false,
      pinned: false,
    };
    byModel.set(key, entry);
    if (!entry.accounts.includes(account)) entry.accounts.push(account);
    if (model.isDefault) entry.defaultOn.push(account);
    entry.legacy &&= isLegacy(model);
    entry.supersededSomewhere ||= isLegacy(model);
    entry.pinned ||=
      model.favourite === true ||
      (model.isDefault && model.defaultSource === "user") ||
      callerModel(model, caller);
  }
  return [...byModel.values()];
}

/** Whether `a` is a newer release of its line than `b`: by version, else not superseded anywhere. */
function newer(a: Merged, b: Merged): boolean {
  const versions =
    a.first.version && b.first.version ? compareVersions(a.first.version, b.first.version) : 0;
  if (versions) return versions > 0;
  return !a.supersededSomewhere && b.supersededSomewhere;
}

/**
 * Current models in catalog order. A long list keeps every pinned and default model, then the
 * newest current release of each line across all accounts in catalog order, up to the cap. A
 * pinned or default model never takes its line's place: the line's newest release still shows.
 */
function listed(models: readonly Merged[]): Merged[] {
  const keep = models.filter((model) => model.pinned || model.defaultOn.length || !model.legacy);
  if (keep.length <= defaultModelsPerProvider) return keep;
  const newest = new Map<string, Merged>();
  for (const model of keep) {
    if (model.legacy) continue;
    const family = familyOf(model.first);
    const held = newest.get(family);
    if (!held || newer(model, held)) newest.set(family, model);
  }
  const chosen = new Set(keep.filter((model) => model.pinned || model.defaultOn.length));
  const lines = new Set(newest.values());
  for (const model of keep) {
    if (chosen.size >= defaultModelsPerProvider) break;
    if (lines.has(model)) chosen.add(model);
  }
  return keep.filter((model) => chosen.has(model));
}

/** Every mode up to the caller's own, the usual set an account offers a child. */
function usualAccess(access: AccessMode | null): string {
  return access ? AccessMode.options.slice(0, AccessMode.options.indexOf(access) + 1).join() : "";
}
/** The CLI's own login carries this generic label; its id already says as much. */
const genericLabel = "Your CLI login";

function accountEntry(
  account: RosterAccount,
  usual: string,
  defaultModel?: string,
): AgentModelsAccount {
  const label = account.accountLabel?.trim();
  return {
    id: account.accountId,
    ...(label && label !== genericLabel && label !== account.accountId ? { label } : {}),
    ...(account.auth === "logged_in" ? {} : { auth: account.auth }),
    ...(account.availability &&
    account.availability !== "available" &&
    !(account.availability === "unknown" && account.auth === "unknown")
      ? { availability: account.availability }
      : {}),
    ...(account.allowedAccessModes.join() === usual
      ? {}
      : { access: [...account.allowedAccessModes] }),
    ...(account.installed ? {} : { installed: false as const }),
    ...(account.enabled === false ? { enabled: false as const } : {}),
    ...(defaultModel ? { default: defaultModel } : {}),
  };
}

/**
 * How a set names an account: its label when `delegate` would resolve that label to this very
 * account (no account has it as an id, and no other account shares it), else its id.
 */
function accountNames(accounts: readonly RosterAccount[], named: readonly NamedAccount[]) {
  return (id: string) => {
    const label = accounts.find((entry) => entry.accountId === id)?.accountLabel?.trim();
    return label && accountForName(named, undefined, label)?.id === id ? label : id;
  };
}

function providerGroup(
  provider: ProviderKind,
  accounts: readonly RosterAccount[],
  shown: readonly Merged[],
  all: readonly Merged[],
  omitted: number,
  context: { usual: string; nameOf: (id: string) => string },
): AgentModelsProvider {
  const ids = accounts.map((account) => account.accountId);
  // Defaults come from the whole catalogue, so a query that finds one account's default never
  // makes it the provider's.
  const defaults = new Map<string, string>();
  for (const model of all)
    for (const account of model.defaultOn)
      if (!defaults.has(account)) defaults.set(account, model.id);
  const agreed = new Set(ids.map((id) => defaults.get(id)));
  const shared = agreed.size === 1 ? [...agreed][0] : undefined;
  const sets = new Map<string, AgentModelsSet>();
  for (const model of shown) {
    const efforts = effortsOf(model.first);
    const serving = ids.every((id) => model.accounts.includes(id))
      ? undefined
      : model.accounts.map(context.nameOf);
    const key = JSON.stringify([efforts, model.first.defaultEffort, serving, model.legacy]);
    const set: AgentModelsSet = sets.get(key) ?? {
      ids: [],
      efforts: efforts.join(),
      ...(model.first.defaultEffort ? { defaultEffort: model.first.defaultEffort } : {}),
      ...(serving ? { accounts: serving } : {}),
      ...(model.legacy ? { legacy: true as const } : {}),
    };
    sets.set(key, set);
    set.ids.push(model.id);
    const name = nameOf(model.first);
    if (name) set.names = { ...set.names, [model.id]: name };
  }
  return {
    provider,
    accounts: accounts.map((account) =>
      accountEntry(account, context.usual, shared ? undefined : defaults.get(account.accountId)),
    ),
    ...(shared ? { default: shared } : {}),
    sets: [...sets.values()],
    ...(omitted ? { omitted } : {}),
  };
}

/** The efforts string most sets carry, stated once on the roster and dropped from those sets. */
function sharedEfforts(groups: readonly AgentModelsProvider[]): string | undefined {
  const counts = new Map<string, number>();
  for (const group of groups)
    for (const set of group.sets)
      if (set.efforts) counts.set(set.efforts, (counts.get(set.efforts) ?? 0) + 1);
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  if (!best || best[1] < 2) return undefined;
  for (const group of groups)
    for (const set of group.sets) if (set.efforts === best[0]) delete set.efforts;
  return best[0];
}

/**
 * The compact roster an agent reads before delegating. With no query: each provider's current
 * models, every account once, shared efforts stated once, and a count of what was left out.
 * With a query: the nearest models across every account, legacy ones included.
 */
export function modelRoster(input: RosterInput): AgentModelRoster {
  const { caller } = input;
  const merged = merge(input.rows, caller);
  const named =
    input.named ??
    input.accounts.map((account) => ({
      id: account.accountId,
      label: account.accountLabel ?? "",
      provider: account.provider,
    }));
  const context = {
    usual: usualAccess(caller.access),
    nameOf: accountNames(input.accounts, named),
  };
  const own = input.rows.find(({ model }) => callerModel(model, caller));
  const groups = (chosen: readonly Merged[], omitted: (provider: ProviderKind) => number) => {
    const providers = [
      ...new Set([
        ...chosen.map((model) => model.provider),
        ...input.accounts.map((account) => account.provider),
      ]),
    ];
    const present = providers.filter((provider) =>
      chosen.some((model) => model.provider === provider),
    );
    const empty = input.query
      ? []
      : providers.filter((provider) => !merged.some((model) => model.provider === provider));
    const built = present.map((provider) =>
      providerGroup(
        provider,
        input.accounts.filter((account) => account.provider === provider),
        chosen.filter((model) => model.provider === provider),
        merged.filter((model) => model.provider === provider),
        omitted(provider),
        context,
      ),
    );
    const shared = sharedEfforts(built);
    return {
      providers: built,
      ...(shared ? { efforts: shared } : {}),
      ...(empty.length ? { noModels: empty } : {}),
      caller: {
        provider: caller.provider,
        ...(own ? { model: own.model.id } : caller.model ? { model: caller.model } : {}),
        access: caller.access,
      },
    };
  };
  if (input.query) {
    const order = new Map<string, number>();
    for (const model of searchModels(
      input.rows.map((row) => row.model).filter(runnable),
      input.query,
    )) {
      const key = `${model.provider}\u0000${model.id}`;
      if (!order.has(key)) order.set(key, order.size);
    }
    const rank = (model: Merged) => order.get(`${model.provider}\u0000${model.id}`) ?? -1;
    const found = merged
      .filter((model) => rank(model) >= 0)
      .toSorted((a, b) => rank(a) - rank(b))
      .slice(0, queryMatches);
    return groups(found, () => 0);
  }
  // The caller's own provider leads; the rest keep the catalog's account order.
  const shown = [...new Set(merged.map((model) => model.provider))]
    .toSorted((a, b) => Number(b === caller.provider) - Number(a === caller.provider))
    .flatMap((provider) => listed(merged.filter((model) => model.provider === provider)));
  return groups(
    shown,
    (provider) =>
      merged.filter((model) => model.provider === provider).length -
      shown.filter((model) => model.provider === provider).length,
  );
}
