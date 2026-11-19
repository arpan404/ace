import { z } from "zod";

/**
 * How `ace update apply --outcome` ended, written beside the install before the updater exits,
 * so the daemon that runs afterwards can say why an update requested from elsewhere didn't
 * happen (ADR 0113). `busy`: running agents outlasted the drain.
 */
export const UpdateOutcome = z.object({
  ok: z.boolean(),
  error: z.string().max(2000).nullable(),
  busy: z.boolean().optional(),
});
export type UpdateOutcome = z.infer<typeof UpdateOutcome>;

export const updateOutcomeFile = "update-outcome.json";

/** The updater's failures, in words for the person reading the machine's status. */
export function updateFailure(error: unknown, running: string | undefined): UpdateOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Active threads block update")
    return {
      ok: false,
      error: "Agents were still working when the update's wait ran out.",
      busy: true,
    };
  if (message === "Release is not newer")
    return { ok: false, error: "This machine already runs that release or a newer one." };
  if (message === "Candidate health check failed")
    return {
      ok: false,
      error: `The new version didn't start, so ace went back to ${running ?? "the previous version"}.`,
    };
  if (message === "Installed target/channel mismatch")
    return { ok: false, error: "The release doesn't match this machine's platform or channel." };
  return { ok: false, error: message.slice(0, 2000) || "The update failed." };
}
