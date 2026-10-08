import { z } from "zod";

/** `ace doctor --json` (packages/diagnostics); parsed again here because it crosses processes. */
export {
  DiagnosticCheck as DoctorCheck,
  DiagnosticReport as DoctorReport,
  Toolchain,
} from "@ace/protocol";
import type { DiagnosticReport as DoctorReport } from "@ace/protocol";
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
