import type { Account } from "@ace/conductor";
import type { ConductorSpec } from "@ace/protocol";
import { pickInstance } from "@ace/accounts";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "../agent-control/delegations.ts";
import type { ExecutionJournal } from "./journal.ts";
export function capacityUse(context: ServiceContext, delegations: DelegationService) {
  const selections = context.services.engine?.activeExecutionSelections() ?? [];
  const accounts = new Map(
    selections.map((entry) => [entry.thread_id, entry.instance_id ?? `local.${entry.provider}`]),
  );
  for (const edge of delegations.journal.active())
    accounts.set(
      edge.childId,
      context.services.engine?.sessionMetadata(edge.childId).instanceId ??
        `local.${edge.request.provider}`,
    );
  return [...accounts].map(([threadId, account]) => ({ threadId, account }));
}
export function executionAccounts(
  context: ServiceContext,
  delegations: DelegationService,
  journal: ExecutionJournal,
  spec?: ConductorSpec,
  run?: string,
): Account[] {
  const { services, now } = context;
  const active = capacityUse(context, delegations);
  const reservations = delegations.journal.reservations();
  const own = new Set(run ? journal.lanes(run).map((lane) => lane.thread) : []);
  const external = (account: string) =>
    active.filter((entry) => !own.has(entry.threadId) && entry.account === account).length +
    reservations.filter(
      (entry) =>
        !own.has(entry.record.childId) &&
        (entry.accountId ?? `local.${entry.record.request.provider}`) === account,
    ).length;
  const managed = services.accountRegistry?.list() ?? [];
  const accounts: Account[] = managed
    .filter(
      ({ instance }) =>
        instance.provider !== "acp" &&
        (!spec ||
          (spec.constraints.accounts.includes(instance.id) &&
            spec.constraints.providers.includes(instance.provider))),
    )
    .map(({ instance, quota }) => {
      const available = pickInstance(
        { provider: instance.provider, role: "deck", estimatedLoad: 0 },
        [{ instance, quota }],
        now(),
      );
      return {
        id: instance.id,
        provider: instance.provider,
        capacity: delegations.policy.maxConcurrent,
        externalActive: Math.min(64, external(instance.id)),
        quota: available ? 100 : 0,
        resetAt: null,
      };
    });
  for (const provider of spec?.constraints.providers ?? []) {
    if (
      !spec?.constraints.accounts.includes(`local.${provider}`) ||
      provider === "acp" ||
      managed.some(({ instance }) => instance.provider === provider)
    )
      continue;
    try {
      services.engine?.capabilities(provider);
    } catch {
      continue;
    }
    accounts.push({
      id: `local.${provider}`,
      provider,
      capacity: delegations.policy.maxConcurrent,
      externalActive: Math.min(64, external(`local.${provider}`)),
      quota: 1_000_000,
      resetAt: null,
    });
  }
  return accounts;
}
