import { z } from "zod";

export const ProviderKind = z.enum([
  "claude",
  "codex",
  "opencode",
  "cursor",
  "antigravity",
  "acp",
  "pi",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * The provider's original payload, stored verbatim. Never interpreted by
 * clients except for debugging views; adapters can re-derive from it.
 */
export const InlineRawPayload = z.object({
  /** Native type or method name, e.g. `commandExecution`, `tool_use`, `session/update`. */
  type: z.string(),
  /** Native tool name when the provider sends one (`Bash`, `apply_patch`, `bash`…). */
  name: z.string().optional(),
  data: z.unknown(),
});
export const RawPayload = z.union([
  InlineRawPayload,
  z.object({
    type: z.string(),
    name: z.string().optional(),
    blobRef: z.string().min(1),
    size: z.number().int().nonnegative(),
    preview: z
      .string()
      .refine((text) => new TextEncoder().encode(text).length <= 2048)
      .meta({ "x-ace-constraint": "UTF-8 encoding must be at most 2048 bytes." }),
  }),
]);
export type RawPayload = z.infer<typeof RawPayload>;
