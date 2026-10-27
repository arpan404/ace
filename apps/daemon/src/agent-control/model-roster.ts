import {
  AccessMode,
  type AgentModelRoster,
  type AgentModelsAccount,
  type AgentModelsProvider,
  type AgentModelsSet,
  type CatalogModel,
  type ProviderKind,
} from "@ace/protocol";
import { executionModelId, matchesModel, searchModels } from "@ace/models";

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
      pinned: false,
    };
    byModel.set(key, entry);
    if (!entry.accounts.includes(account)) entry.accounts.push(account);
    if (model.isDefault) entry.defaultOn.push(account);
    entry.legacy &&= isLegacy(model);
    entry.pinned ||=
      model.favourite === true ||
      (model.isDefault && model.defaultSource === "user") ||
      callerModel(model, caller);
  }
  return [...byModel.values()];
}

/** Current models in catalog order; a long list keeps pinned and default ones plus one per line. */
function listed(models: readonly Merged[]): Merged[] {
  const keep = models.filter((model) => model.pinned || model.defaultOn.length || !model.legacy);
  if (keep.length <= defaultModelsPerProvider) return keep;
  const chosen = new Set(keep.filter((model) => model.pinned || model.defaultOn.length));
  const families = new Set([...chosen].map((model) => familyOf(model.first)));
  for (const model of keep) {
    if (chosen.size >= defaultModelsPerProvider) break;
    const family = familyOf(model.first);
    if (model.legacy || families.has(family)) continue;
    families.add(family);
    chosen.add(model);
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

/** How a set names an account: its label when no other account shares it, else its id. */
function accountNames(accounts: readonly RosterAccount[]) {
  const counts = new Map<string, number>();
  const key = (account: RosterAccount) => account.accountLabel?.trim().toLowerCase() ?? "";
  for (const account of accounts) counts.set(key(account), (counts.get(key(account)) ?? 0) + 1);
  return (id: string) => {
    const account = accounts.find((entry) => entry.accountId === id);
    const label = account?.accountLabel?.trim();
    return account && label && counts.get(key(account)) === 1 ? label : id;
  };
}

function providerGroup(
  provider: ProviderKind,
  accounts: readonly RosterAccount[],
  shown: readonly Merged[],
  omitted: number,
  context: { usual: string; nameOf: (id: string) => string },
): AgentModelsProvider {
  const ids = accounts.map((account) => account.accountId);
  const defaults = new Map<string, string>();
  for (const model of shown)
    for (const account of model.defaultOn)
      if (!defaults.has(account)) defaults.set(account, model.id);
  const shared = new Set(defaults.values()).size === 1 ? [...defaults.values()][0] : undefined;
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
  const context = { usual: usualAccess(caller.access), nameOf: accountNames(input.accounts) };
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
