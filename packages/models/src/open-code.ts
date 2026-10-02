import { CatalogModel } from "@ace/protocol";
import { OpenCodeModel } from "./native-schemas.ts";
import { base } from "./model.ts";
import type { ModelInstance } from "./types.ts";

/** Retains one bounded native object at a time, plus at most 512 normalized rows. */
export class OpenCodeParser {
  readonly #instance: ModelInstance;
  readonly #rows: CatalogModel[] = [];
  #heading: string | undefined;
  #json: string[] = [];
  #bytes = 0;
  constructor(instance: ModelInstance) {
    this.#instance = instance;
  }
  push(line: string): void {
    this.#bytes += Buffer.byteLength(line) + 1;
    if (this.#bytes > 4 * 1024 * 1024) throw new Error("Model metadata output exceeded limit");
    if (!this.#heading) {
      if (!line.trim()) return;
      if (!/^[^\s/]+\/\S+$/.test(line.trim())) throw new Error("Malformed model heading");
      this.#heading = line.trim();
      return;
    }
    this.#json.push(line);
    if (line !== "}" && !(this.#json.length === 1 && line.startsWith("{") && line.endsWith("}")))
      return;
    const native = OpenCodeModel.parse(JSON.parse(this.#json.join("\n")));
    if (this.#heading !== `${native.providerID}/${native.id}`)
      throw new Error("Model heading mismatch");
    const model = base(this.#instance, this.#heading, native.name, native);
    model.nativeProviderId = native.providerID;
    model.nativeModelId = native.id;
    if (native.limit?.context !== undefined) model.contextWindow = native.limit.context;
    model.inputModalities = Object.entries(native.capabilities?.input ?? {})
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);
    model.reasoningEfforts = Object.keys(native.variants);
    model.deprecated = native.status === "deprecated";
    this.#rows.push(CatalogModel.parse(model));
    if (this.#rows.length > 512) throw new Error("Too many models");
    this.#heading = undefined;
    this.#json = [];
  }
  finish(): CatalogModel[] {
    if (this.#heading !== undefined) throw new Error("Incomplete model metadata");
    return this.#rows;
  }
}
