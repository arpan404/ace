import type { AccountView } from "./accounts.ts";
import { joinNames } from "./join-names.ts";
import type { UsageAccount } from "./usage-limits.ts";

/*
 * Which machines (environments) a Usage figure counts. A machine that couldn't be read is never
 * dropped from the totals silently: the coverage line names it and says why.
 */

/** Whether a machine's usage made it into the figures. */
export type UsageMachineReach = "counted" | "loading" | "offline" | "failed";

export interface UsageMachine {
  id: string;
  name: string;
  reach: UsageMachineReach;
}

export interface UsageCoverage {
  counted: number;
  total: number;
  /** Every machine in scope is counted. */
  complete: boolean;
  /** "2 of 3 machines · Studio is offline"; null for a single machine that is counted. */
  line: string | null;
  missing: { id: string; name: string; reach: Exclude<UsageMachineReach, "counted"> }[];
}

const reasons: Record<Exclude<UsageMachineReach, "counted">, [one: string, many: string]> = {
  offline: ["is offline", "are offline"],
  failed: ["couldn't be read", "couldn't be read"],
  loading: ["is still loading", "are still loading"],
};

/** How many of `machines` the figures count, and which are missing, in words. */
export function usageCoverage(machines: readonly UsageMachine[]): UsageCoverage {
  const missing = machines.flatMap((machine) =>
    machine.reach === "counted"
      ? []
      : [{ id: machine.id, name: machine.name, reach: machine.reach }],
  );
  const total = machines.length;
  const counted = total - missing.length;
  const complete = missing.length === 0;
  if (complete)
    return { counted, total, complete, line: total > 1 ? `All ${total} machines` : null, missing };
  const said = (["offline", "failed", "loading"] as const).flatMap((reach) => {
    const these = missing.filter((machine) => machine.reach === reach).map((m) => m.name);
    if (these.length === 0) return [];
    const [one, many] = reasons[reach];
    return [`${joinNames(these)} ${these.length === 1 ? one : many}`];
  });
  // One machine needs no count: "Studio is offline" says it all.
  const head = total === 1 ? [] : [`${counted} of ${total} machines`];
  return { counted, total, complete, line: [...head, ...said].join(" · "), missing };
}

/** One machine's accounts as the Usage page lists them; undefined while they load. */
export interface MachineAccounts {
  id: string;
  name: string;
  accounts: readonly AccountView[] | undefined;
}

/** Every machine's accounts for the limits, one provider's when `provider` is given. */
export function usageAccounts(
  machines: readonly MachineAccounts[],
  provider?: string,
): UsageAccount[] {
  return machines.flatMap((machine) =>
    (machine.accounts ?? [])
      .filter((account) => provider === undefined || account.provider === provider)
      .map((account) => ({ account, environment: machine.name, environmentId: machine.id })),
  );
}

/** The providers any machine has an account for, in the order they first appear. */
export function usageAccountProviders(machines: readonly MachineAccounts[]): string[] {
  return [
    ...new Set(machines.flatMap((machine) => (machine.accounts ?? []).map((a) => a.provider))),
  ];
}
