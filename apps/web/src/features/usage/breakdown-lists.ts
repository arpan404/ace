import { ProviderKind } from "@ace/protocol";
import {
  providerNames,
  rankBreakdown,
  rankLines,
  roleLabels,
  pricedUsd,
  usageTokens,
  type AccountView,
  type BreakdownKind,
} from "@ace/ui-core";
import type { Machine } from "@/lib/machines.ts";
import { breakdownDimensions, type EnvironmentRead } from "./usage-data.ts";
import type { BreakdownLists } from "./where-it-went.tsx";

type MachineRead = EnvironmentRead & { environment: Machine };

/**
 * Every "Where it went" list from the machines read: each daemon's own breakdown rows, the
 * model rows the report already reads, and one figure per machine.
 */
export function breakdownLists(machines: readonly MachineRead[]): BreakdownLists {
  const lists: BreakdownLists = {
    model: rankBreakdown(
      machines.map((read) => read.usage.models),
      "model",
    ),
    machine: rankLines(
      machines
        .map((read) => ({
          key: read.environment.id,
          tokens: read.usage.daily.reduce((sum, row) => sum + usageTokens(row.totals), 0),
          usd: read.usage.daily.reduce((sum, row) => sum + pricedUsd(row.totals), 0),
        }))
        .filter((line) => line.tokens > 0),
    ),
  };
  for (const dimension of breakdownDimensions) {
    const answered = machines.flatMap((read) => {
      const rows = read.breakdowns[dimension];
      return rows ? [rows] : [];
    });
    // Machines whose daemon doesn't record the dimension are left out, not counted as zero.
    if (answered.length) lists[dimension] = rankBreakdown(answered, dimension);
  }
  return lists;
}

const providerName = (id: string) => {
  const kind = ProviderKind.safeParse(id);
  return kind.success ? providerNames[kind.data] : id;
};

/** Names for each list's keys, from what the page already reads. */
export function breakdownNamer(input: {
  machines: readonly MachineRead[];
  accounts: readonly AccountView[];
  machineList: readonly Machine[];
  project(id: string): string;
  automation(id: string): string | undefined;
  modelName(provider: string, model: string): string;
}): (kind: BreakdownKind | "provider", key: string) => string {
  const accounts = new Map(
    input.accounts.map((account) => [account.id, `${account.providerLabel} · ${account.label}`]),
  );
  const modelProvider = new Map<string, string>();
  for (const read of input.machines)
    for (const row of read.usage.models)
      if (row.dimensions.model && row.dimensions.provider)
        modelProvider.set(row.dimensions.model, row.dimensions.provider);
  // The same model through several providers reads the same; the provider tells them apart.
  const modelLabel = (key: string) => input.modelName(modelProvider.get(key) ?? "", key);
  const labelCount = new Map<string, number>();
  for (const key of modelProvider.keys())
    labelCount.set(modelLabel(key), (labelCount.get(modelLabel(key)) ?? 0) + 1);
  return (kind, key) => {
    switch (kind) {
      case "workspace":
        return input.project(key);
      case "account":
        return accounts.get(key) ?? "Account";
      case "model": {
        const label = modelLabel(key);
        return (labelCount.get(label) ?? 0) > 1
          ? `${label} · ${providerName(modelProvider.get(key) ?? "")}`
          : label;
      }
      case "automation":
        return input.automation(key) ?? "Automation";
      case "role":
        return roleLabels[key] ?? key;
      case "machine":
        return input.machineList.find((machine) => machine.id === key)?.name ?? "Machine";
      case "provider":
        return providerName(key);
      default:
        return key;
    }
  };
}
