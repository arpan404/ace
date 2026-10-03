import { z } from "zod";
import { AcpSession, ConfigOption, isModelConfig } from "./native-schemas.ts";

const id = z.string().min(1).max(256);
const CursorModels = z
  .object({
    models: z
      .array(
        z
          .object({ value: id, name: id, configOptions: z.array(ConfigOption).max(64).optional() })
          .passthrough(),
      )
      .max(512),
  })
  .passthrough();
export function cursorSessionOptions(session: unknown, listing: unknown): unknown {
  const parsed = AcpSession.parse(session);
  const rows = CursorModels.parse(listing).models;
  const current =
    parsed.configOptions?.find(isModelConfig)?.currentValue ?? parsed.models?.currentModelId;
  return {
    ...parsed,
    configOptions: [
      ...(parsed.configOptions ?? []).filter((option) => !isModelConfig(option)),
      { id: "model", category: "model", type: "select", currentValue: current, options: rows },
    ],
  };
}
/** provider-kit represents RPC errors as serialized native error objects. */
export function isMissingMethod(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    return z.object({ code: z.literal(-32601) }).safeParse(JSON.parse(error.message)).success;
  } catch {
    return false;
  }
}

const SdkModels = z
  .array(
    z
      .object({
        id,
        displayName: id,
        aliases: z.array(id).max(32).optional(),
        parameters: z
          .array(
            z
              .object({
                id,
                displayName: id.optional(),
                values: z
                  .array(z.object({ value: id, displayName: id.optional() }).passthrough())
                  .max(32),
              })
              .passthrough(),
          )
          .max(32)
          .optional(),
        variants: z
          .array(
            z
              .object({
                displayName: id,
                isDefault: z.boolean().optional(),
                params: z.array(z.object({ id, value: id }).passthrough()).max(16),
              })
              .passthrough(),
          )
          .max(32)
          .optional(),
      })
      .passthrough(),
  )
  .max(512);
export function decodeCursorSdkModels(payload: unknown) {
  return SdkModels.parse(payload);
}
