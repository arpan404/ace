import { explicitInstance, pickInstance, type Candidate } from "@ace/accounts";
import { AcpIdentity, type DelegationRequest, type Thread, type CatalogModel } from "@ace/protocol";
import { AccountProvider } from "@ace/protocol/accounts";
import { executionModelId, selectionModelFilter } from "@ace/models";
import { modelsAvailableWithoutAuth } from "@ace/models/availability";
import { cursorDefaultInstanceId } from "@ace/provider-kit/cursor-selection";
import { selectedDelegationModel } from "./models.ts";
import { AgentControlError } from "./failure.ts";
import type { DelegationDependencies } from "./delegations.ts";

function withoutAuth(deps: DelegationDependencies, model: CatalogModel) {
  return modelsAvailableWithoutAuth(
    [model],
    deps.models.list({ provider: model.provider, instance: model.instance }).instances,
  );
}
function eligible(
  deps: DelegationDependencies,
  candidate: Candidate,
  model: CatalogModel,
): Candidate {
  // This is an admission view, never a mutation of the user's recorded auth state.
  return withoutAuth(deps, model)
    ? { instance: candidate.instance, quota: { ...candidate.quota, auth: "logged_in" } }
    : candidate;
}
function checkAuth(
  deps: DelegationDependencies,
  input: DelegationRequest,
  model: CatalogModel,
  instance: string,
) {
  const auth =
    deps.accounts?.get(instance)?.quota.auth ??
    deps.engine.providerAvailability(input.provider).auth;
  if (auth === "logged_out" && !withoutAuth(deps, model))
    throw new AgentControlError(
      "account_unavailable",
      "Selected account/model requires authentication",
    );
  if (deps.providerEnabled?.(input.provider, instance) === false)
    throw new AgentControlError("provider_disabled", "Selected account is disabled");
}

/** Choose the account before checking its authentication against its actual selected model. */
export function delegationSelection(
  deps: DelegationDependencies,
  input: DelegationRequest,
  parent: Thread,
  now: number,
  configured?: string,
) {
  const provider = AccountProvider.safeParse(input.provider === "acp" ? undefined : input.provider);
  const candidates = provider.success
    ? (deps.accounts
        ?.list()
        .filter(
          (entry) =>
            entry.instance.provider === provider.data &&
            (input.accountId ? entry.instance.id === input.accountId : !entry.instance.implicit),
        ) ?? [])
    : [];
  const request = {
    provider: provider.success ? provider.data : ("acp" as const),
    role: input.role,
    estimatedLoad: input.estimatedLoad,
  };
  const views: Candidate[] = [];
  for (const candidate of candidates) {
    try {
      const model = selectedDelegationModel(
        deps.models,
        input,
        parent,
        candidate.instance.id,
        configured,
      );
      views.push(eligible(deps, candidate, model));
    } catch (error) {
      if (!(error instanceof AgentControlError) || error.code !== "model_unavailable") throw error;
    }
  }
  const selected =
    input.accountId && views[0]
      ? explicitInstance(request, views[0], now)
      : pickInstance(request, views, now);
  if (provider.success && (input.accountId || candidates.length > 0) && !selected)
    throw new AgentControlError("account_unavailable", "Account unavailable or quota exhausted");
  const instance =
    selected?.id ??
    input.instanceId ??
    (input.provider === "cursor" ? cursorDefaultInstanceId : `${input.provider}-cli-default`);
  const model = selectedDelegationModel(deps.models, input, parent, instance, configured);
  checkAuth(deps, input, model, instance);
  return {
    ...(selected ? { accountId: selected.id } : {}),
    resolvedModel: executionModelId(model),
  };
}

/** Recheck the immutable account/model after asynchronous workspace preparation. */
export function validateDelegationSelection(
  deps: DelegationDependencies,
  input: DelegationRequest,
  modelId: string | undefined,
  accountId: string | undefined,
  now: number,
) {
  const instance =
    accountId ??
    input.instanceId ??
    (input.provider === "cursor" ? cursorDefaultInstanceId : `${input.provider}-cli-default`);
  const filter = selectionModelFilter(
    input.provider,
    instance,
    input.provider === "acp" ? AcpIdentity.parse(input) : undefined,
  );
  const resolved = filter && deps.models.resolve({ ...filter, role: input.role, model: modelId });
  if (!resolved?.ok || executionModelId(resolved.model) !== modelId)
    throw new AgentControlError("model_unavailable", "Selected model is no longer available");
  checkAuth(deps, input, resolved.model, instance);
  if (!accountId) return;
  const account = deps.accounts?.get(accountId);
  if (
    !account ||
    !explicitInstance(
      { provider: account.instance.provider, role: input.role, estimatedLoad: input.estimatedLoad },
      eligible(deps, account, resolved.model),
      now,
    )
  )
    throw new AgentControlError("account_unavailable", "Account unavailable or quota exhausted");
}
