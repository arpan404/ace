import { pickerEntries, type PickerEntry } from "./picker-entries.ts";
import { pickerList } from "./model-picker.ts";
import {
  newThreadModelList,
  type NewThreadAgents,
  type NewThreadModelRow,
} from "./mobile-new-thread.ts";
import { resetCountdown } from "./usage-limits.ts";

/*
 * The native model picker's tabs, by the web picker's rules: Favorites, then one tab per account
 * that is set up (`pickerEntries`), each listing that account's models in the picker's order.
 * Favorites lists the starred models in the order they were starred, each once, on the account
 * in use where it can (`pickerList`).
 */

export interface NewThreadTab {
  /** "favorites", or `provider:instance` (a provider with nothing listed: its kind). */
  id: string;
  provider: string | undefined;
  instance: string | undefined;
  /** "Codex", or "Codex · Work" when the provider has several accounts. */
  name: string;
  /** Why it can't take work now (at its limit, signed out); absent when it can. */
  reason: string | undefined;
  /** Its models as model and account; Favorites' come from every provider. */
  models: { key: string; account: string }[];
  /** How many show before "More models". */
  lead: number;
}

export function newThreadTabs(
  agents: NewThreadAgents,
  input: {
    favorites: readonly string[];
    /** The draft's provider, model and account, whose tab always shows. */
    current: { provider: string; key: string; account: string } | undefined;
  },
): NewThreadTab[] {
  const { picker } = agents;
  const keep = agents.providers.find((row) => row.provider === input.current?.provider);
  const entries: PickerEntry[] = pickerEntries(
    picker.providers,
    picker.models,
    picker.accounts,
    picker.now,
    (at) => {
      const left = at === undefined ? null : resetCountdown(at, picker.now);
      return left ? `Limit reached · resets in ${left}` : "Limit reached";
    },
    keep ? { provider: keep.provider, instance: input.current?.account } : undefined,
  );
  const rows = new Map(agents.providers.map((row) => [row.provider, row.models]));
  const starred = pickerList(picker.models, {
    query: "",
    favorites: input.favorites,
    instance: input.current?.account,
  }).rows.flatMap((model) => (model.instance ? [{ key: model.key, account: model.instance }] : []));
  return entries.map((entry): NewThreadTab => {
    if (entry.id === "favorites") return { ...tab(entry), models: starred, lead: starred.length };
    const own: NewThreadModelRow[] = (
      entry.provider ? (rows.get(entry.provider) ?? []) : []
    ).filter((model) => entry.instance === undefined || model.account === entry.instance);
    const inUse =
      input.current && input.current.provider === entry.provider ? input.current : undefined;
    const list = newThreadModelList(own, inUse);
    return {
      ...tab(entry),
      models: list.models.map((model) => ({ key: model.key, account: model.account })),
      lead: list.lead,
    };
  });
}

function tab(entry: PickerEntry): Omit<NewThreadTab, "models" | "lead"> {
  return {
    id: entry.id,
    provider: entry.provider,
    instance: entry.instance,
    name: entry.name,
    reason: entry.reason,
  };
}
