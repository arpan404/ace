import { z } from "zod";
import type { ModelSource, ModelSourceStatus, CatalogModel } from "@ace/protocol";
import { normalizeOpenCodeV2 } from "./open-code.ts";
import { discoveryError } from "./discovery-errors.ts";
import type { DiscoveryReport, ModelInstance } from "./types.ts";

/** A bad connected provider cannot erase healthy providers or its own last good choices. */
export function normalizeOpenCodeReport(
  payload: unknown,
  instance: ModelInstance,
  connected: ReadonlyMap<string, ModelSource>,
): DiscoveryReport & { missingMetadata: readonly string[] } {
  const envelope = z
    .object({
      location: z.object({ directory: z.literal(instance.cwd) }),
      data: z.array(z.unknown()).max(8192),
      configuredDefault: z.string().optional(),
      errors: z
        .array(z.object({ providerID: z.string().max(256), error: z.unknown() }))
        .max(512)
        .optional(),
    })
    .parse(payload);
  const grouped = new Map<string, unknown[]>();
  for (const raw of envelope.data) {
    const identity = z.object({ providerID: z.string() }).safeParse(raw);
    if (!identity.success || !connected.has(identity.data.providerID)) continue;
    const group = grouped.get(identity.data.providerID) ?? [];
    group.push(raw);
    grouped.set(identity.data.providerID, group);
  }
  const models: CatalogModel[] = [];
  const sources: ModelSourceStatus[] = [];
  const missingMetadata: string[] = [];
  for (const [id, source] of connected) {
    try {
      const failed = envelope.errors?.find((error) => error.providerID === id);
      if (failed) {
        sources.push({
          source,
          status: "stale",
          error: discoveryError(failed.error, "discovery_failed", {
            provider: "opencode",
            source: id,
          }),
        });
        continue;
      }
      const rows = normalizeOpenCodeV2({ ...envelope, data: grouped.get(id) ?? [] }, instance);
      if (!rows.length) {
        missingMetadata.push(id);
        sources.push({
          source,
          status: "stale",
          error: discoveryError(new Error("No model metadata returned")),
        });
      } else {
        models.push(...rows.map((row) => Object.assign({}, row, { source })));
        sources.push({ source, status: "fresh" });
      }
    } catch (error) {
      sources.push({ source, status: "stale", error: discoveryError(error) });
    }
  }
  if (models.length > 512) throw new Error("Too many connected models");
  return { models, sources, missingMetadata };
}
