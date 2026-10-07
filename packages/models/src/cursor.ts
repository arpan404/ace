import { z } from "zod";

const id = z.string().min(1).max(256);
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
