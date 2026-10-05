import { z } from "zod";
import { ProviderKind } from "./provider.ts";

export const ProviderErrorDetails = z.object({
  code: z.string().min(1).max(256),
  provider: ProviderKind,
  title: z.string().max(256).optional(),
  detail: z.string().max(2048).optional(),
  model: z.string().min(1).max(256).optional(),
});
export type ProviderErrorDetails = z.infer<typeof ProviderErrorDetails>;
