import type { ModelCatalogApi } from "@ace/models";
import { matchesModel } from "@ace/models";
import type { ProviderKind } from "@ace/protocol";
import { accountForName, type NamedAccount } from "../agent-control/account-names.ts";
import { TargetRefusal } from "./target-refusal.ts";

/** How long a delegate waits for a cold account's model list before checking the model. */
const LOAD_MS = 10_000;
const noop = () => {};

function named(account: NamedAccount): string {
  const label = account.label.trim();
  return label && label !== account.id ? `${label} (${account.id})` : account.id;
}

/** Words fit the refusal's 512 characters; the list is cut, never the reason. */
function clipped(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * The account a delegate from another machine named, as this machine's account id: an exact id
 * of an account on `provider`, else the one `provider` account whose label matches (any case).
 * Anything else is refused with this machine's accounts for that provider; it never falls back
 * to the default.
 */
export function machineAccount(
  accounts: readonly NamedAccount[],
  provider: ProviderKind,
  name: string,
  host: string,
): string {
  const own = accounts.filter((entry) => entry.provider === provider);
  const match = accountForName(own, provider, name);
  if (match) return match.id;
  const listed = own.length
    ? `Its ${provider} accounts: ${own.map(named).join(", ")}. Pass one as accountId, or omit accountId for its default.`
    : `It has no ${provider} accounts to choose from; omit accountId for its default.`;
  throw new TargetRefusal(
    "invalid",
    clipped(`${host} has no ${provider} account "${name}". ${listed}`),
  );
}

/**
 * Refuses a model the chosen account doesn't serve, naming what it does serve. A model list that
 * is still empty after waiting on discovery says nothing either way, so it is left to the run.
 */
export async function checkAccountModel(input: {
  catalog: ModelCatalogApi | undefined;
  provider: ProviderKind;
  account: string;
  model: string;
  host: string;
  schedule(ms: number, run: () => void): () => void;
}): Promise<void> {
  const { catalog, provider, account, model } = input;
  if (!catalog) return;
  const filter = { provider, instance: account };
  const load = catalog.loadMissing?.(filter);
  if (load) {
    let cancel: () => void = noop;
    await Promise.race([
      load.catch(() => undefined),
      new Promise<void>((resolve) => {
        cancel = input.schedule(LOAD_MS, resolve);
      }),
    ]).finally(() => cancel());
  }
  const rows = catalog
    .list({ ...filter, limit: 100 })
    .models.filter((row) => !row.hidden && !row.deprecated);
  if (!rows.length || rows.some((row) => matchesModel(row, model))) return;
  const served = rows
    .slice(0, 8)
    .map((row) => row.id)
    .join(", ");
  throw new TargetRefusal(
    "invalid",
    clipped(
      `Account ${account} on ${input.host} does not serve ${model}. It serves ${served}. Pass one of those as model, or another accountId.`,
    ),
  );
}
