import type { MutationLease } from "@ace/provider-kit/cleanup";

export interface MutationState {
  status: "available" | "quarantined";
  leases: readonly MutationLease[];
}

/** Unknown durable intents are denied, including intents left by a daemon crash. */
export function leaseState(
  records: readonly MutationLease[],
  known: ReadonlyMap<string, { quarantined: boolean }>,
): MutationState {
  const leases = records.filter((record) => {
    const active = known.get(record.id);
    return !active || active.quarantined;
  });
  return { status: leases.length ? "quarantined" : "available", leases };
}
