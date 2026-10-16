import { z } from "zod";
import { ThreadId } from "./ids.ts";

const id = z.string().min(1).max(128);
/** Allowlisted credential names. The transport admits nothing else. */
export const ToolEnvKey = z.enum(["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "SSH_AUTH_SOCK"]);
export type ToolEnvKey = z.infer<typeof ToolEnvKey>;
export const ToolEnvValue = z
  .string()
  .min(1)
  .max(8192)
  // oxlint-disable-next-line eslint/no-control-regex -- Values are printable text such as tokens, hosts and socket paths, never terminal control input.
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .meta({
    secret: true,
    "x-ace-secret": true,
    writeOnly: true,
    description:
      "Ephemeral per-thread tool credential held only in daemon memory. Never log or persist.",
  });
export type ToolEnvValue = z.infer<typeof ToolEnvValue>;
export const ToolEnvEntry = z.strictObject({ key: ToolEnvKey, value: ToolEnvValue });
export type ToolEnvEntry = z.infer<typeof ToolEnvEntry>;
export const ToolEnvRequest = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("provider.toolEnv.submit"),
    requestId: id,
    threadId: ThreadId,
    entries: z.array(ToolEnvEntry).min(1).max(4),
  }),
  z.strictObject({ type: z.literal("provider.toolEnv.clear"), requestId: id, threadId: ThreadId }),
]);
export type ToolEnvRequest = z.infer<typeof ToolEnvRequest>;
export const ToolEnvResult = z.object({
  type: z.literal("provider.toolEnv.result"),
  requestId: id,
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), stored: z.number().int().min(0).max(4) }),
    z.object({
      ok: z.literal(false),
      error: z.enum(["forbidden", "unavailable", "busy", "not_found", "invalid_input"]),
    }),
  ]),
});
export type ToolEnvResult = z.infer<typeof ToolEnvResult>;
