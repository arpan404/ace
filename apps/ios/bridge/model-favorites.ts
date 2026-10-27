import type { ClientCore } from "@ace/client";
import { ProviderConfigurations } from "@ace/protocol";
import { editProviderConfiguration, favoriteModelKeys, withFavoriteToggled } from "@ace/ui-core";
import { z } from "zod";

/*
 * The picker's stars, where the web keeps them: each provider's row in `providers.configuration`
 * (`favoriteModelKeys`, `withFavoriteToggled` in `@ace/ui-core`). A star goes through the shared
 * editor (`editProviderConfiguration`): it rereads the setting first and writes one change at a
 * time, with the provider page's edits, so a field changed meanwhile survives.
 */

type Owner = Pick<ClientCore, "request">;
/** Maps a saved id to the catalog's (`catalogModelIds`). */
export type Canonical = (provider: string, id: string | null | undefined) => string | null;

const key = "providers.configuration";
const quiet = { timeoutMs: 15_000 };
const Entries = z.object({
  ok: z.boolean().optional(),
  entries: z.array(z.object({ value: z.unknown() })).optional(),
});

export class ModelFavorites {
  readonly #owner: Owner;
  constructor(owner: Owner) {
    this.#owner = owner;
  }

  /** The starred models as picker keys; none when the setting can't be read. */
  async read(canonical: Canonical): Promise<string[]> {
    return favoriteModelKeys(await this.#rows().catch(() => []), canonical);
  }

  /** Star or unstar `model` (a picker key) and give back every star as saved. */
  async toggle(model: string, canonical: Canonical): Promise<string[]> {
    let after: ProviderConfigurations = [];
    await editProviderConfiguration(this.#owner, (before) => {
      after = withFavoriteToggled(before, model, canonical) ?? before;
      return after;
    });
    return favoriteModelKeys(after, canonical);
  }

  async #rows(): Promise<ProviderConfigurations> {
    const reply = Entries.parse(
      await this.#owner.request({ type: "settings.get", key, scope: {} }, quiet),
    );
    if (reply.ok === false) throw new Error("Couldn't read provider preferences.");
    return ProviderConfigurations.catch([]).parse(reply.entries?.[0]?.value ?? []);
  }
}
