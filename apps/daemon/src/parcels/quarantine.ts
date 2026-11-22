import type { ParcelRows } from "./store.ts";

/** What a sending thread reads about a parcel its org host won't send. */
export const orgHostParcelRefusal = "An organization's host sends no parcels to other machines.";

/**
 * On an organization's host, fails every parcel still on its way to another machine, queued
 * before the machine was enrolled or since (ADR 0209 §4.2). Each sending thread is told through
 * `settle`. Copies to threads on this machine carry on. Returns how many it failed.
 */
export function quarantineOnOrgHost(
  rows: Pick<ParcelRows, "openToMachines">,
  settle: (parcelId: string, state: "failed", reason: string) => void,
): number {
  let failed = 0;
  // Bounded passes: each one settles what it read, so the next finds the rest.
  for (let pass = 0; pass < 16; pass++) {
    const open = rows.openToMachines();
    if (!open.length) break;
    for (const row of open) settle(row.parcelId, "failed", orgHostParcelRefusal);
    failed += open.length;
  }
  return failed;
}
