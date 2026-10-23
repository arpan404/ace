import type { ClientCore } from "@ace/client";
import { ProviderConfigurations } from "@ace/protocol";
import { favoriteModelKeys, withFavoriteToggled } from "@ace/ui-core";
import { z } from "zod";

/*
 * The picker's stars, where the web keeps them: each provider's row in `providers.configuration`
 * (`favoriteModelKeys`, `withFavoriteToggled` in `@ace/ui-core`). A star rereads the setting first
 * and writes one change at a time, so a field another device changed meanwhile survives.
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
const Saved = z.object({ ok: z.boolean() });

export class ModelFavorites {
  readonly #owner: Owner;
  #writes: Promise<unknown> = Promise.resolve();
  constructor(owner: Owner) {
    this.#owner = owner;
  }

  /** The starred models as picker keys; none when the setting can't be read. */
  async read(canonical: Canonical): Promise<string[]> {
    return favoriteModelKeys(await this.#rows().catch(() => []), canonical);
  }

  /** Star or unstar `model` (a picker key) and give back every star as saved. */
  toggle(model: string, canonical: Canonical): Promise<string[]> {
    const next = this.#writes
      .catch(() => {})
      .then(async () => {
        const before = await this.#rows();
        const after = withFavoriteToggled(before, model, canonical);
        if (!after) return favoriteModelKeys(before, canonical);
        const reply = await this.#owner.request(
          { type: "settings.set", key, value: after, layer: { kind: "global" } },
          quiet,
        );
        if (!Saved.parse(reply).ok) throw new Error("Couldn't save this favourite.");
        return favoriteModelKeys(after, canonical);
      });
    this.#writes = next;
    return next;
  }

  async #rows(): Promise<ProviderConfigurations> {
    const reply = Entries.parse(
      await this.#owner.request({ type: "settings.get", key, scope: {} }, quiet),
    );
    if (reply.ok === false) throw new Error("Couldn't read provider preferences.");
    return ProviderConfigurations.catch([]).parse(reply.entries?.[0]?.value ?? []);
  }
}
