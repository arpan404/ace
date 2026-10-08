import { createHash } from "node:crypto";
import type { CatalogModel } from "@ace/protocol";
import { freezeCatalogModel } from "./freeze.ts";

/** Share immutable metadata across identical account catalogs; routing and freshness stay separate. */
export class ModelMetadataPool {
  readonly #rows = new Map<string, CatalogModel>();
  intern(model: CatalogModel): CatalogModel {
    const { reasoningEfforts, serviceTiers, inputModalities, raw, aliases } = model;
    const key = createHash("sha256")
      .update(JSON.stringify({ reasoningEfforts, serviceTiers, inputModalities, raw, aliases }))
      .digest("hex");
    const shared = this.#rows.get(key);
    if (shared)
      return freezeCatalogModel({
        ...model,
        reasoningEfforts: shared.reasoningEfforts,
        serviceTiers: shared.serviceTiers,
        inputModalities: shared.inputModalities,
        raw: shared.raw,
        ...(shared.aliases ? { aliases: shared.aliases } : {}),
      });
    const frozen = freezeCatalogModel(model);
    if (this.#rows.size >= 1024) this.#rows.delete(this.#rows.keys().next().value ?? "");
    this.#rows.set(key, frozen);
    return frozen;
  }
  clear(): void {
    this.#rows.clear();
  }
}
