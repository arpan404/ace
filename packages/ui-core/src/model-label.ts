import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "./providers.ts";

/*
 * One way to name a model everywhere (UX audit TN-4): the provider, then the model, "Claude Code
 * · Default". Where the provider is already beside the name (the chip's provider mark, a
 * provider's column in the picker) a named model reads alone, "Opus 4.1"; the provider's own
 * default never does, since "Default" alone doesn't say whose.
 */

const separator = " · ";
const recommended = /\s*\(recommended\)\s*$/i;

/** The model is the provider's default: none named, or a catalog row that calls itself that. */
function isDefault(provider: ProviderKind, name: string): boolean {
  const plain = name.trim().toLowerCase();
  return plain === "" || plain === "default" || plain === `${provider}:default`;
}

/**
 * A model's name where its provider shows beside it: "Opus 4.1", or "Claude Code · Default" for
 * the provider's default (no model named, or the catalog's "Default (recommended)").
 */
export function modelName(provider: ProviderKind, displayName?: string): string {
  const name = (displayName ?? "").replace(recommended, "");
  return isDefault(provider, name) ? modelLine(provider, undefined) : name.trim();
}

/**
 * Provider then model, for places that show no provider beside it: "Claude Code · Opus 4.1",
 * with the account's tag between them when one is named: "Claude Code · work · Default".
 */
export function modelLine(
  provider: ProviderKind,
  displayName: string | undefined,
  account?: string | undefined,
): string {
  const prefix = `${providerNames[provider]}${separator}`;
  // A default's name already carries its provider: never say it twice.
  const own = displayName?.startsWith(prefix) ? displayName.slice(prefix.length) : displayName;
  const name = (own ?? "").replace(recommended, "");
  return [providerNames[provider], account, isDefault(provider, name) ? "Default" : name.trim()]
    .filter(Boolean)
    .join(separator);
}
