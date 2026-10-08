import { z } from "zod";
export const AccountAuthMethod = z.enum(["browser", "api_key", "unknown"]);
export const ApiKeySupport = z.object({
  supported: z.boolean(),
  reason: z.string().max(256).optional(),
  upstreams: z.array(z.string().max(64)).max(16).optional(),
});
