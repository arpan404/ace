import { z } from "zod";
/** Host logging can admit this adapter diagnostic without decoding whole provider frames. */
export const CodexExitDiagnostic = z.object({
  event: z.literal("codex-session-exit"),
  generation: z.string().min(1).max(1024),
  deliberate: z.boolean(),
  retirement: z.enum(["idle", "user", "shutdown", "aborted", "open_failed"]).nullable(),
  reason: z.enum(["exit", "signal", "stopped", "spawn-error", "output-limit"]),
  code: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  pid: z.number().int().positive().optional(),
  stderrSummary: z.string().max(1024),
  stderr: z.string().refine((value) => new TextEncoder().encode(value).length <= 4096),
});
export type CodexExitDiagnostic = z.infer<typeof CodexExitDiagnostic>;
