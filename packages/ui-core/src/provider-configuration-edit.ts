import type { ClientApi } from "@ace/client";
import {
  ProviderConfiguration,
  ProviderConfigurations,
  type CatalogModel,
  type ProviderKind,
} from "@ace/protocol";

/*
 * Changing `providers.configuration`, the one setting that holds every provider's preferences:
 * turning a provider off, its CLI path, Cursor's checkpoint budget, its default and hidden
 * models and custom models. Every client edits it the same way: reread, change one provider's
 * row, write, one edit at a time, so a field another device changed meanwhile survives.
 */

/** What editing the setting needs of the SDK client. */
export type ConfigurationClient = Pick<ClientApi, "request">;

const writes = new WeakMap<ConfigurationClient, Promise<void>>();

/** Serialize this client's edits and reread first so fields edited elsewhere survive. */
export function editProviderConfiguration(
  client: ConfigurationClient,
  change: (rows: ProviderConfigurations) => ProviderConfigurations,
): Promise<void> {
  const next = (writes.get(client) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const reply = await client.request({
        type: "settings.get",
        key: "providers.configuration",
        scope: {},
      });
      if (!reply.ok)
        throw new Error("Couldn't read provider preferences. Reconnect and try again.");
      const before = ProviderConfigurations.parse(reply.entries[0]?.value ?? []);
      const value = ProviderConfigurations.parse(change(before));
      const saved = await client.request({
        type: "settings.set",
        key: "providers.configuration",
        value,
        layer: { kind: "global" },
      });
      if (!saved.ok)
        throw new Error("Couldn't save provider preferences. Check the values and try again.");
    });
  writes.set(client, next);
  void next
    .finally(() => {
      if (writes.get(client) === next) writes.delete(client);
    })
    .catch(() => {});
  return next;
}

type Row = ProviderConfiguration;
/** A change to one row, or why the typed value can't be saved. */
export type RowChange = { ok: true; change: (row: Row) => Row } | { ok: false; problem: string };

export const binaryPathProblem =
  "Enter the full path to the executable, or clear it to find the CLI automatically.";
export const checkpointProblem =
  "Enter a whole number of megabytes from 1 to 256, or clear it for the default.";

/** The CLI path as typed: an absolute path, or empty to find the CLI automatically. */
export function binaryPathChange(typed: string): RowChange {
  const path = typed.trim();
  if (path && !ProviderConfiguration.shape.binaryPath.safeParse(path).success)
    return { ok: false, problem: binaryPathProblem };
  return {
    ok: true,
    change: (row) => {
      const { binaryPath: _before, ...rest } = row;
      return path ? { ...rest, binaryPath: path } : rest;
    },
  };
}

/** Cursor's checkpoint budget as typed, in MB: 1 to 256, or empty for the default. */
export function checkpointChange(typed: string): RowChange {
  const text = typed.trim();
  if (!text)
    return {
      ok: true,
      change: (row) => {
        const { maxCheckpointMb: _before, ...rest } = row;
        return rest;
      },
    };
  const parsed = ProviderConfiguration.shape.maxCheckpointMb.safeParse(
    /^\d+$/.test(text) ? Number(text) : Number.NaN,
  );
  if (!parsed.success) return { ok: false, problem: checkpointProblem };
  return { ok: true, change: (row) => ({ ...row, maxCheckpointMb: parsed.data }) };
}

/** Whether the picker hides `model`: hidden here, or hidden by the catalog's own rules. */
export function modelHidden(row: Row | undefined, model: CatalogModel): boolean {
  return (
    row?.hiddenModels?.includes(model.id) === true ||
    model.visibilityReason === "model_hidden" ||
    model.visibilityReason === "deprecated" ||
    model.visibilityReason === "provider_hidden"
  );
}

/** Show a hidden model or hide a shown one, by its id and every alias. */
export function modelVisibilityChange(
  model: Pick<CatalogModel, "id" | "aliases">,
  hidden: boolean,
): (row: Row) => Row {
  const ids = new Set([model.id, ...(model.aliases ?? [])]);
  return (row) => ({
    ...row,
    hiddenModels: hidden
      ? (row.hiddenModels ?? []).filter((id) => !ids.has(id))
      : [...new Set([...(row.hiddenModels ?? []), model.id])],
    shownModels: hidden
      ? [...new Set([...(row.shownModels ?? []), model.id])]
      : (row.shownModels ?? []).filter((id) => !ids.has(id)),
  });
}

/** A custom model the CLI knows by `id`, or why it can't be added. */
export function customModelChange(
  row: Row | undefined,
  typedId: string,
  typedName: string,
): RowChange {
  const id = typedId.trim();
  const displayName = typedName.trim();
  const element = ProviderConfiguration.shape.customModels.unwrap().element;
  if (!element.safeParse({ id, displayName }).success)
    return { ok: false, problem: "Enter the model name the CLI uses and a display name." };
  if (row?.customModels?.some((model) => model.id === id))
    return { ok: false, problem: "That model is already added." };
  return {
    ok: true,
    change: (current) => ({
      ...current,
      customModels: [...(current.customModels ?? []), { id, displayName }],
    }),
  };
}

/** Take a custom model off the list. */
export function customModelRemoval(id: string): (row: Row) => Row {
  return (row) => ({
    ...row,
    customModels: (row.customModels ?? []).filter((model) => model.id !== id),
  });
}

/** The provider-wide row (not an account's override), when one is saved. */
export function providerRow(
  rows: readonly Row[] | undefined,
  provider: ProviderKind,
): Row | undefined {
  return rows?.find((row) => row.provider === provider && row.instance === undefined);
}
