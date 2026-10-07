import { conductorStartRejection } from "@ace/conductor/commands";
import type { ConductorSpec, ProviderKind, ProviderStatus } from "@ace/protocol";
import type { FakeServices } from "../services/index.ts";
import type { FakeProjects } from "../projects.ts";

const usable = (status: ProviderStatus | undefined) =>
  status?.installed && status.auth !== "logged_out";

/** Project/provider/account facts come from the fake host's existing catalogs. */
export function fakeStartRejection(
  spec: ConductorSpec,
  projects: FakeProjects,
  catalog: Pick<FakeServices, "accounts" | "providerStatuses">,
): string | undefined {
  const statuses = new Map(catalog.providerStatuses.map((status) => [status.provider, status]));
  const accounts: { provider: ProviderKind; quota: number }[] = catalog.accounts
    .filter((account) => spec.constraints.accounts.includes(account.id))
    .map((account) => ({
      provider: account.provider,
      quota:
        account.availability !== "logged_out" &&
        account.availability !== "exhausted" &&
        (!account.implicit || usable(statuses.get(account.provider)))
          ? 1
          : 0,
    }));
  for (const provider of spec.constraints.providers) {
    if (
      provider !== "acp" &&
      spec.constraints.accounts.includes(`local.${provider}`) &&
      !catalog.accounts.some((account) => account.provider === provider && !account.implicit) &&
      usable(statuses.get(provider))
    )
      accounts.push({ provider, quota: 1 });
  }
  return conductorStartRejection(spec, {
    workspaceExists: !!projects.get(spec.workspaceId),
    workspaceGit: projects.isGit(spec.workspaceId),
    installed: new Set(
      catalog.providerStatuses
        .filter((status) => status.installed)
        .map((status) => status.provider),
    ),
    accounts,
  });
}
