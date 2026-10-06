import { z } from "zod";

/** A durable ownership identity, never a PID that can be reused. */
export const MutationLease = z.object({
  version: z.literal(1),
  id: z.uuid(),
  root: z.string().min(1).max(4096),
  owner: z.object({ port: z.number().int().min(1).max(65535), token: z.uuid() }).optional(),
  roots: z.array(z.string().min(1).max(4096)).min(1).max(256),
});
export type MutationLease = z.infer<typeof MutationLease>;

export const CleanupResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), evidence: z.string().min(1) }),
  z.object({ status: z.literal("unconfirmed"), reason: z.string().min(1) }),
]);
export type CleanupResult = z.infer<typeof CleanupResult>;

/** Separate from command completion. Only containment evidence can release ownership. */
export interface CleanupReceipt {
  settled: Promise<CleanupResult>;
}

/** Implementations must cover escaped descendants, including ones without inherited pipes.
 * Exit, close, a successful kill request, PID absence and a deadline are not proof.
 * Recovery must reconcile durable identities against the supervisor's own journal.
 */
export interface MutationCleanupSupervisor<Process> {
  stop(process: Process, leases: readonly MutationLease[]): CleanupReceipt;
  recover(lease: MutationLease): Promise<CleanupResult>;
}
