import { ProviderConfigurations, ProviderKind, type ProviderConfiguration } from "@ace/protocol";
import { modelKey } from "./models.ts";
import { toggleFavorite } from "./model-picker.ts";

/*
 * Favorite models live with each provider's preferences (`providers.configuration`, the
 * provider-wide row's `favourites`), so every client stars the same models. Keys are
 * `modelKey(provider, id)`; `canonical` (`catalogModelIds`) maps a saved alias to the
 * catalog's id so a model renamed in the catalog stays starred.
 */

type Canonical = (provider: string, id: string | null | undefined) => string | null;

/** One provider's provider-wide row changed by `change`, added when it has none. */
export function changeProvider(
  rows: ProviderConfigurations,
  provider: ProviderKind,
  change: (row: ProviderConfiguration) => ProviderConfiguration,
): ProviderConfigurations {
  const own = rows.findIndex((row) => row.provider === provider && row.instance === undefined);
  if (own === -1) return ProviderConfigurations.parse([...rows, change({ provider })]);
  return ProviderConfigurations.parse(
    rows.map((row, index) => (index === own ? change(row) : row)),
  );
}

/** Every starred model as a picker key, provider by provider in the order they were starred. */
export function favoriteModelKeys(
  rows: readonly ProviderConfiguration[],
  canonical: Canonical,
): string[] {
  return rows.flatMap((row) =>
    row.instance === undefined
      ? (row.favourites ?? []).map((id) =>
          modelKey(row.provider, canonical(row.provider, id) ?? id),
        )
      : [],
  );
}

/**
 * The preferences with `key` starred or unstarred on its provider's row; saved aliases are
 * folded to their catalog ids first, so a star never doubles. Undefined when `key` names no
 * provider.
 */
export function withFavoriteToggled(
  rows: ProviderConfigurations,
  key: string,
  canonical: Canonical,
): ProviderConfigurations | undefined {
  const split = key.indexOf("\u0000");
  const provider = ProviderKind.safeParse(key.slice(0, split));
  if (split < 0 || !provider.success) return undefined;
  const id = key.slice(split + 1);
  return changeProvider(rows, provider.data, (row) => ({
    ...row,
    favourites: toggleFavorite(
      [...new Set((row.favourites ?? []).map((saved) => canonical(provider.data, saved) ?? saved))],
      id,
    ),
  }));
}
