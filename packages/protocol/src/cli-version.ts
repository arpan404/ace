import { z } from "zod";

/**
 * Where an installed external CLI stands against the oldest version ace supports. Only a
 * readable version below `required` is `too_old`; a newer one is always `ok`.
 */
export const CliVersionCheck = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    installed: z.string().min(1).max(64),
    required: z.string().min(1).max(64),
  }),
  z.object({
    status: z.literal("too_old"),
    installed: z.string().min(1).max(64),
    required: z.string().min(1).max(64),
  }),
  z.object({ status: z.literal("unreadable"), required: z.string().min(1).max(64) }),
]);
export type CliVersionCheck = z.infer<typeof CliVersionCheck>;
