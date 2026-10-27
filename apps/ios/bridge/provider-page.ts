import type { ClientCore } from "@ace/client";
import {
  ProviderConfigurations,
  ProviderKind,
  type NativePermissionMode,
  type ProviderConfiguration,
} from "@ace/protocol";
import {
  binaryPathChange,
  catalogModelIds,
  changeProvider,
  checkpointChange,
  customModelChange,
  customModelRemoval,
  editProviderConfiguration,
  modelVisibilityChange,
  providerRow,
  readModelCatalog,
  withFavoriteToggled,
  type ModelCatalog,
  type RowChange,
} from "@ace/ui-core";
import { z } from "zod";
import { otherProviders, providerPage, type ProviderPage } from "./provider-page-view.ts";

/*
 * The provider page's reads and edits, answered as native service calls. A read gathers the
 * provider's readiness, its saved preferences, its native modes and its models in parallel; an
 * edit changes one preference with the shared reread-then-write editor (`@ace/ui-core`), so the
 * phone and the web never lose each other's fields. Wording comes from `provider-page-view.ts`.
 */

export const ProviderPageRequest = z.object({
  type: z.literal("provider.page"),
  provider: ProviderKind,
});
export const OtherProvidersRequest = z.object({ type: z.literal("providers.others") });

const id = z.string().min(1).max(256);
const Change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enabled"), on: z.boolean() }),
  z.object({ kind: z.literal("path"), value: z.string().max(4096) }),
  z.object({ kind: z.literal("checkpoint"), value: z.string().max(16) }),
  z.object({ kind: z.literal("nativeMode"), mode: z.string().max(256) }),
  z.object({ kind: z.literal("defaultModel"), id: id.nullable() }),
  z.object({
    kind: z.literal("modelHidden"),
    id,
    aliases: z.array(id).max(32),
    hidden: z.boolean(),
  }),
  z.object({ kind: z.literal("favourite"), key: z.string().min(1).max(600) }),
  z.object({ kind: z.literal("hideDeprecated"), on: z.boolean() }),
  z.object({ kind: z.literal("onlyFavourites"), on: z.boolean() }),
  z.object({ kind: z.literal("addCustom"), id: z.string().max(512), name: z.string().max(512) }),
  z.object({ kind: z.literal("removeCustom"), id }),
  z.object({ kind: z.literal("refreshModels") }),
  z.object({ kind: z.literal("checkAgain") }),
]);
export const ProviderEditRequest = z.object({
  type: z.literal("provider.edit"),
  provider: ProviderKind,
  change: Change,
});
export type ProviderEdit = z.infer<typeof ProviderEditRequest>;

/** An edit's answer: saved, or why not in words Swift shows under the row. */
export type EditReply = { ok: true } | { ok: false; message: string };

type Owner = Pick<ClientCore, "request">;
const quiet = { timeoutMs: 15_000 };
const Entries = z.object({
  ok: z.boolean(),
  entries: z.array(z.object({ value: z.unknown() })).optional(),
});
const NativeModes = z.record(z.string(), z.string()).catch({});

/** What the computer is called, read once per runtime; "the computer" until it answers. */
export function machineLabel(owner: Owner): () => Promise<string> {
  let name: string | undefined;
  return async () => {
    if (name) return name;
    try {
      const reply = await owner.request({ type: "host.identity" }, quiet);
      name = reply.identity.displayName || undefined;
    } catch {
      /* Asked again next time. */
    }
    return name ?? "the computer";
  };
}

async function setting(
  owner: Owner,
  key: "providers.configuration" | "access.nativeModes",
  signal: AbortSignal,
): Promise<unknown> {
  const reply = Entries.parse(
    await owner.request({ type: "settings.get", key, scope: {} }, { ...quiet, signal }),
  );
  if (!reply.ok) throw new Error("Couldn't read this computer's settings.");
  return reply.entries?.[0]?.value;
}

export class ProviderPages {
  readonly #owner: Owner;
  readonly #machine: () => Promise<string>;
  /** Each provider's last read catalog ids, so a star names the catalog's own model. */
  #catalogs = new Map<ProviderKind, ModelCatalog>();
  constructor(owner: Owner, machine: () => Promise<string>) {
    this.#owner = owner;
    this.#machine = machine;
  }

  /** Rejects when the computer can't say how its providers stand. */
  async page(
    request: z.infer<typeof ProviderPageRequest>,
    signal: AbortSignal,
  ): Promise<ProviderPage> {
    const { provider } = request;
    const options = { ...quiet, signal };
    const [readiness, configurations, native, modes, catalog, machine] = await Promise.all([
      this.#owner.request({ type: "providers.request", operation: "readiness" }, options),
      setting(this.#owner, "providers.configuration", signal)
        .then((value) => ProviderConfigurations.catch([]).parse(value ?? []))
        .catch((): ProviderConfiguration[] => []),
      setting(this.#owner, "access.nativeModes", signal)
        .then((value) => NativeModes.parse(value ?? {}))
        .catch((): Record<string, string> => ({})),
      this.#modes(provider, signal),
      readModelCatalog(this.#owner, { provider }, signal).catch(() => undefined),
      this.#machine(),
    ]);
    if (!readiness.result.ok) throw new Error(readiness.result.error);
    if (catalog) this.#catalogs.set(provider, catalog);
    return providerPage({
      provider,
      status: readiness.result.providers.find((row) => row.provider === provider),
      configuration: providerRow(configurations, provider),
      configurations,
      nativeMode: native[provider] ?? "",
      modes,
      catalog,
      machine,
    });
  }

  async others(signal: AbortSignal): Promise<ReturnType<typeof otherProviders>> {
    const reply = await this.#owner.request(
      { type: "providers.request", operation: "readiness" },
      { ...quiet, signal },
    );
    if (!reply.result.ok) throw new Error(reply.result.error);
    return otherProviders(reply.result.providers);
  }

  async edit(request: ProviderEdit, signal: AbortSignal): Promise<EditReply> {
    const { provider, change } = request;
    try {
      switch (change.kind) {
        case "nativeMode":
          return await this.#nativeMode(provider, change.mode, signal);
        case "refreshModels": {
          await this.#owner.request(
            { type: "models.refresh", filter: { provider } },
            { ...quiet, signal },
          );
          return { ok: true };
        }
        case "checkAgain": {
          const reply = await this.#owner.request(
            { type: "providers.request", operation: "refresh" },
            { ...quiet, signal },
          );
          return reply.result.ok
            ? { ok: true }
            : { ok: false, message: "Couldn't check providers. Try again." };
        }
        case "favourite": {
          const ids = catalogModelIds(this.#catalogs.get(provider)?.models ?? []);
          await editProviderConfiguration(
            this.#owner,
            (rows) => withFavoriteToggled(rows, change.key, ids) ?? rows,
          );
          return { ok: true };
        }
        default: {
          const row = rowChange(change, await this.#saved(provider, signal));
          if (!row.ok) return { ok: false, message: row.problem };
          await editProviderConfiguration(this.#owner, (rows) =>
            changeProvider(rows, provider, row.change),
          );
          return { ok: true };
        }
      }
    } catch {
      return { ok: false, message: "Couldn't save. Check the connection and try again." };
    }
  }

  async #saved(provider: ProviderKind, signal: AbortSignal) {
    const value = await setting(this.#owner, "providers.configuration", signal);
    return providerRow(ProviderConfigurations.catch([]).parse(value ?? []), provider);
  }

  async #modes(
    provider: ProviderKind,
    signal: AbortSignal,
  ): Promise<NativePermissionMode[] | undefined> {
    try {
      const reply = await this.#owner.request(
        { type: "permissions.capabilities", provider },
        { ...quiet, signal },
      );
      return reply.ok ? (reply.permissions?.permissionModes ?? []) : undefined;
    } catch {
      return undefined;
    }
  }

  async #nativeMode(provider: ProviderKind, mode: string, signal: AbortSignal) {
    const before = NativeModes.parse(
      (await setting(this.#owner, "access.nativeModes", signal)) ?? {},
    );
    const next = { ...before };
    if (mode) next[provider] = mode;
    else delete next[provider];
    const saved = await this.#owner.request(
      { type: "settings.set", key: "access.nativeModes", value: next, layer: { kind: "global" } },
      { ...quiet, signal },
    );
    return saved.ok
      ? ({ ok: true } as const)
      : ({ ok: false, message: "Couldn't save native mode. Reconnect and try again." } as const);
  }
}

type RowEdit = Exclude<
  z.infer<typeof Change>,
  { kind: "nativeMode" | "refreshModels" | "checkAgain" | "favourite" }
>;

/** One preference change as a change to the provider's row, or why it can't be saved. */
function rowChange(change: RowEdit, saved: ProviderConfiguration | undefined): RowChange {
  switch (change.kind) {
    case "enabled":
      return { ok: true, change: (row) => ({ ...row, enabled: change.on }) };
    case "path":
      return binaryPathChange(change.value);
    case "checkpoint":
      return checkpointChange(change.value);
    case "defaultModel":
      return { ok: true, change: (row) => ({ ...row, defaultModel: change.id }) };
    case "modelHidden":
      return {
        ok: true,
        change: modelVisibilityChange({ id: change.id, aliases: change.aliases }, change.hidden),
      };
    case "hideDeprecated":
      return { ok: true, change: (row) => ({ ...row, hideDeprecated: change.on }) };
    case "onlyFavourites":
      return { ok: true, change: (row) => ({ ...row, showOnlyFavourites: change.on }) };
    case "addCustom":
      return customModelChange(saved, change.id, change.name);
    case "removeCustom":
      return { ok: true, change: customModelRemoval(change.id) };
  }
}
