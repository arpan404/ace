import { z } from "zod";

/** `ace doctor --json` (packages/diagnostics); parsed again here because it crosses processes. */
export const DoctorCheck = z.object({
  id: z.string().max(128),
  status: z.enum(["ok", "warn", "fail"]),
  message: z.string().max(2048),
  fix: z.string().max(2048),
});
export const DoctorReport = z.object({ at: z.number(), checks: z.array(DoctorCheck).max(64) });
export type DoctorReport = z.infer<typeof DoctorReport>;

export const ProviderSummary = z.object({
  id: z.string(),
  installed: z.boolean(),
  auth: z.enum(["logged_in", "logged_out", "unknown"]),
  detail: z.string(),
  /** How to log in, in the provider's own CLI. ace never handles credentials (ADR 0002). */
  hint: z.string(),
});
export type ProviderSummary = z.infer<typeof ProviderSummary>;

/**
 * Providers the daemon's discovery reports, from the doctor's `provider.*` checks. A check
 * message reads `claude: 2.1.0, logged_in` or `codex: CLI not installed`.
 */
export function providerSummaries(report: DoctorReport): ProviderSummary[] {
  return report.checks
    .filter((check) => check.id.startsWith("provider."))
    .map((check) => {
      const id = check.id.slice("provider.".length);
      const installed = !check.message.includes("CLI not installed");
      const auth = /\blogged_in\b/.test(check.message)
        ? "logged_in"
        : /\blogged_out\b/.test(check.message)
          ? "logged_out"
          : "unknown";
      return { id, installed, auth, detail: check.message, hint: check.fix };
    });
}

export const Toolchain = z.object({
  id: z.enum(["xcode", "android", "git"]),
  available: z.boolean(),
  detail: z.string(),
  hint: z.string(),
});
export type Toolchain = z.infer<typeof Toolchain>;
