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
    // Execution, including New thread, uses nativeModelId as the provider/model selector.
    const model = base(this.#instance, this.#heading, native.name, native);
    model.nativeProviderId = native.providerID;
    if (native.limit?.context !== undefined) model.contextWindow = native.limit.context;
    model.inputModalities = Object.entries(native.capabilities?.input ?? {})
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);
    model.reasoningEfforts = Object.keys(native.variants);
    model.deprecated = native.status === "deprecated" || native.status === "legacy";
    model.legacy = native.status === "legacy";
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

/** The v2 network catalog is location-scoped and has array-valued variants. */
export function normalizeOpenCodeV2(
  payload: unknown,
  instance: ModelInstance,
  connected?: ReadonlySet<string>,
): CatalogModel[] {
  const parsed = V2Catalog.parse(payload);
  if (parsed.location.directory !== instance.cwd)
    throw new Error("OpenCode model location mismatch");
  const seen = new Set<string>();
  const available: z.infer<typeof V2Model>[] = [];
  for (const raw of parsed.data) {
    // Catalog metadata for providers without a connection cannot affect usable rows.
    const provider = V2Provider.safeParse(raw);
    if (connected && (!provider.success || !connected.has(provider.data.providerID))) continue;
    const native = V2Model.parse(raw);
    const id = `${native.providerID}/${native.modelID}`;
    if (seen.has(id)) continue;
    seen.add(id);
    available.push(native);
    if (available.length > 512) throw new Error("Too many connected models");
  }
  return available.map((native) => {
    // Keep the qualified execution selector supplied by base in nativeModelId.
    const model = base(instance, `${native.providerID}/${native.modelID}`, native.name, native);
    model.nativeProviderId = native.providerID;
    model.contextWindow = native.limit.context;
    model.inputModalities = Object.entries(native.capabilities.input)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    model.reasoningEfforts = native.variants.map((variant) => variant.id);
    model.hidden = !native.enabled;
    model.deprecated = native.status === "deprecated" || native.status === "legacy";
    model.legacy = native.status === "legacy";
    return CatalogModel.parse(model);
  });
}
import { z } from "zod";
const V2Provider = z.object({ providerID: z.string().min(1).max(256) });
const V2Model = z
  .object({
    id: z.string().min(1).max(256),
    modelID: z.string().min(1).max(256),
    providerID: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    enabled: z.boolean(),
    status: z.string(),
    limit: z
      .object({ context: z.number().int().positive(), output: z.number().int().positive() })
      .passthrough(),
    capabilities: z.object({ input: z.record(z.string(), z.boolean()) }).passthrough(),
    variants: z.array(z.object({ id: z.string().min(1).max(256) }).passthrough()).max(32),
  })
  .passthrough();
const V2Catalog = z
  .object({
    location: z.object({ directory: z.string() }),
    data: z.array(z.unknown()).max(8192),
  })
  .passthrough();
