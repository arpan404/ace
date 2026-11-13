import { ProviderKind } from "@ace/protocol";
import { providerNames, roleLabels, type AccountView, type BreakdownKind } from "@ace/ui-core";
import type { Machine } from "@/lib/machines.ts";
import type { EnvironmentRead } from "./usage-data.ts";

type MachineRead = EnvironmentRead & { environment: Machine };

/**
 * The machines' reads with each model row under its catalog id (`canonical`), so a legacy bare
 * id and its provider-prefixed id count as one model, as the page's totals already do.
 */
export function withCanonicalModels(
  machines: readonly MachineRead[],
  canonical: (provider: string, model: string) => string,
): MachineRead[] {
  return machines.map((read) => ({
    ...read,
    usage: {
      ...read.usage,
      models: read.usage.models.map((row) => {
        const { model, provider } = row.dimensions;
        if (!model) return row;
        const id = canonical(provider ?? "", model);
        return id === model ? row : { ...row, dimensions: { ...row.dimensions, model: id } };
      }),
    },
  }));
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
