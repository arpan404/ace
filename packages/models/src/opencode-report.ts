import { z } from "zod";
import type { ModelSource, ModelSourceStatus, CatalogModel } from "@ace/protocol";
import { normalizeOpenCodeV2 } from "./open-code.ts";
import { discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import { discoveryError } from "./discovery-errors.ts";
import type { DiscoveryDiagnostics, DiscoveryReport, ModelInstance } from "./types.ts";

/** A bad connected provider cannot erase healthy providers or its own last good choices. */
export function normalizeOpenCodeReport(
  payload: unknown,
  instance: ModelInstance,
  connected: ReadonlyMap<string, ModelSource>,
  diagnostic?: (metadata: DiscoveryDiagnostics) => void,
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
  const sourceFailures: { source: string; reason: string }[] = [];
  const failedSource = (source: ModelSource, cause: unknown) => {
    const error = discoveryError(cause, "discovery_failed", { ...instance, source: source.id });
    sources.push({ source, status: "stale", error });
    if (error.code === "discovery_failed")
      sourceFailures.push({
        source: source.id,
        reason: discoveryFailureReason(cause, { env: instance.env }),
      });
  };
  for (const [id, source] of connected) {
    try {
      const failed = envelope.errors?.find((error) => error.providerID === id);
      if (failed) {
        failedSource(source, failed.error);
        continue;
      }
      const rows = normalizeOpenCodeV2({ ...envelope, data: grouped.get(id) ?? [] }, instance);
      if (!rows.length) {
        missingMetadata.push(id);
        failedSource(
          source,
          new Error("OpenCode returned no enabled chat model metadata for this connected source."),
        );
      } else {
        models.push(...rows.map((row) => Object.assign({}, row, { source })));
        sources.push({ source, status: "fresh" });
      }
    } catch (error) {
      failedSource(source, error);
    }
  }
  diagnostic?.({ sourceFailures });
  if (models.length > 512) throw new Error("Too many connected models");
  return { models, sources, missingMetadata };
}
