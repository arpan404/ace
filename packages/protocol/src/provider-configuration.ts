import { z } from "zod";
import { ProviderKind } from "./provider.ts";

const id = z
  .string()
  .min(1)
  .max(256)
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control bytes in wire ids.
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
const ids = z
  .array(id)
  .max(512)
  .refine((rows) => new Set(rows).size === rows.length)
  .meta({ uniqueItems: true, "x-ace-constraint": "IDs must be unique." });
export const ProviderConfiguration = z.object({
  provider: ProviderKind,
  instance: id.optional(),
  enabled: z.boolean().optional(),
  /** Concrete model ID. Null resets an account override to the built-in policy. */
  defaultModel: id
    .refine((value) => value.toLowerCase() !== "default", "Choose a concrete model ID")
    .meta({
      "x-ace-constraint":
        "The pseudo model ID default is not accepted; choose a concrete model ID.",
    })
    .nullable()
    .optional(),
  binaryPath: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^(?:\/|[A-Za-z]:[\\/]).*$/)
    // oxlint-disable-next-line eslint/no-control-regex -- Paths cannot contain control bytes.
    .refine((path) => !/[\x00-\x1f\x7f]/.test(path))
    .meta({ "x-ace-constraint": "Absolute executable path with no control bytes." })
    .optional(),
  customModels: z
    .array(z.object({ id, displayName: z.string().min(1).max(256).regex(/\S/) }))
    .max(128)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
    .meta({ "x-ace-constraint": "Custom model IDs must be unique." })
    .optional(),
  hiddenModels: ids.optional(),
  shownModels: ids.optional(),
  hiddenGroups: ids.optional(),
  shownGroups: ids.optional(),
  favourites: ids.optional(),
  showOnlyFavourites: z.boolean().optional(),
  hideDeprecated: z.boolean().optional(),
});
export type ProviderConfiguration = z.infer<typeof ProviderConfiguration>;
export const ProviderConfigurations = z
  .array(ProviderConfiguration)
  .max(64)
  .refine(
    (rows) =>
      new Set(rows.map((row) => JSON.stringify([row.provider, row.instance]))).size === rows.length,
  )
  .meta({ "x-ace-constraint": "Each provider and optional instance pair must be unique." })
  .and(z.json())
  .meta({ examples: [[]] });
export type ProviderConfigurations = z.infer<typeof ProviderConfigurations>;
