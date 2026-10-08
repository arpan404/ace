import { z } from "zod";

const id = z.string().min(1).max(256);
// SDK strings have no minimum length. Empty parameter values must survive native selection.
const value = z.string().max(256);
const NativeModel = z.object({ id }).passthrough();
const Metadata = z.object({
  displayName: id.optional().catch(undefined),
  parameters: z
    .array(
      z
        .object({
          id,
          values: z.array(z.object({ value }).passthrough()).max(32),
        })
        .passthrough(),
    )
    .max(32)
    .optional()
    .catch(undefined),
  variants: z
    .array(
      z
        .object({
          displayName: id,
          isDefault: z.boolean().optional().catch(undefined),
          params: z.array(z.object({ id, value }).passthrough()).max(16),
        })
        .passthrough(),
    )
    .max(32)
    .optional()
    .catch(undefined),
});
export type CursorModelRejection = { index: number; reason: string };
export function cursorModelParseFailure(): Error {
  return Object.assign(new Error("Cursor SDK returned no readable model entries"), {
    code: "parse_failure",
  });
}

/** Only identity is required. Unused, nullable and future fields stay in native raw data. */
export function decodeCursorSdkModels(
  payload: unknown,
  rejected?: (entry: CursorModelRejection) => void,
) {
  const entries = z.array(z.unknown()).max(512).parse(payload);
  const models = entries.flatMap((entry, index) => {
    const parsed = NativeModel.safeParse(entry);
    if (!parsed.success) {
      // Fixed prose and an array index, never vendor values or Zod's free-text error.
      rejected?.({
        index,
        reason: "Model identity must be a non-empty string of at most 256 characters.",
      });
      return [];
    }
    return [{ index, native: parsed.data, metadata: Metadata.parse(parsed.data) }];
  });
  // Preserve the last-good catalog when every entry is broken, rather than replacing it with [].
  if (entries.length && !models.length) throw cursorModelParseFailure();
  return models;
}
