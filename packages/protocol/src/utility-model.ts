import { z } from "zod";
import { ProviderKind } from "./provider-data.ts";

const label = z.string().min(1).max(256);
/**
 * The model ace uses for short text it writes for the person: thread titles and commit and
 * pull request drafts. `instance` is the account; `effort`, when the model has efforts.
 */
export const UtilityModelChoice = z.object({
  provider: ProviderKind,
  instance: label.optional(),
  model: label,
  effort: label.optional(),
});
export type UtilityModelChoice = z.infer<typeof UtilityModelChoice>;
