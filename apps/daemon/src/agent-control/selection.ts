import { accountLaunchRefusal } from "./account-availability.ts";
import {
  accountProvider,
  automaticRefusal,
  definiteRefusal,
  explicitInstance,
  pickInstance,
  refusalWords,
  type AccountRefusal,
  type Candidate,
} from "@ace/accounts";
import { providerNames } from "@ace/ui-core/providers";
import {
  AcpIdentity,
  type DelegationRequest,
  type Thread,
  type CatalogModel,
  type ProviderKind,
} from "@ace/protocol";
import { AccountProvider } from "@ace/protocol/accounts";
import { executionModelId, isDefaultSelection, selectionModelFilter } from "@ace/models";
import { modelsAvailableWithoutAuth } from "@ace/models/availability";
import { cursorDefaultInstanceId } from "@ace/provider-kit/cursor-selection";
import { delegationEffort, selectedDelegationModel } from "./models.ts";
import { AgentControlError } from "./failure.ts";
import type { DelegationDependencies } from "./delegations.ts";
import { matchAccountName, registeredAccounts } from "./account-names.ts";

/** A refused account: code `account_unavailable`, with the reason the agent may read. */
function unavailable(reason: string): AgentControlError {
  return new AgentControlError("account_unavailable", reason, undefined, reason);
}
function accountName(provider: ProviderKind, candidate: Candidate) {
  const label = candidate.instance.label.trim() || candidate.instance.id;
  return `${providerNames[provider]} account ${label}`;
}
function refused(
  deps: DelegationDependencies,
  provider: ProviderKind,
  candidate: Candidate,
  refusal: AccountRefusal,
  now: number,
): string {
  const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return refusalWords(accountName(provider, candidate), refusal, now, zone);
}

/**
 * The id of the account a request names, by its id or by the label the person gave it ("346"):
 * an exact id first, else the one account of the request's provider with that label (any case).
 * Refuses, saying why, a name no account of that provider has, or a label two of them share.
 */
export function namedAccountId(
  deps: DelegationDependencies,
  input: Pick<DelegationRequest, "provider" | "accountId">,
): string | undefined {
  const name = input.accountId;
  if (!name) return undefined;
  const provider = input.provider;
  // An ACP agent's account is its installation's instance id, checked against its identity at
  // admission; it has no label to resolve.
  if (provider === "acp") return name;
  const accounts = registeredAccounts(deps.accounts);
  const match = matchAccountName(accounts, provider, name);
  const words = providerNames[provider];
  if ("shared" in match)
    throw unavailable(
      `${match.shared.length} ${words} accounts are labelled "${name}"; pass one's id as accountId: ${match.shared.map((entry) => entry.id).join(", ")}`.slice(
        0,
        256,
      ),
    );
  // An added Antigravity account is stored as an ACP account but belongs to Antigravity.
  if ("account" in match && match.account.provider !== provider)
    throw unavailable(
      `Account ${name} does not belong to ${words}; it belongs to ${providerNames[match.account.provider]}`,
    );
  if ("account" in match) return match.account.id;
  // Accounts whose homes are still being validated aren't listed yet; their id is checked later.
  if (deps.accounts?.get(name)) return name;
  throw unavailable(`No ${words} account has "${name}" as its id or label`);
}

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
  now: number,
) {
  // A model that needs no sign-in spends no account usage, so neither check applies to it.
  const free = withoutAuth(deps, model);
  const refusal = free
    ? undefined
    : accountLaunchRefusal(
        deps.accounts?.list() ?? [],
        instance,
        now,
        (id) => deps.providerEnabled?.(input.provider, id) !== false,
      );
  if (refusal) throw unavailable(refusal);
  const auth =
    deps.accounts?.get(instance)?.quota.auth ??
    deps.engine.providerAvailability(input.provider).auth;
  if (auth === "logged_out" && !free) {
    const account = deps.accounts?.get(instance);
    const name = account ? accountName(input.provider, account) : providerNames[input.provider];
    throw unavailable(
      `${name} is signed out and this model requires authentication; the person signs it in again in Settings`,
    );
  }
  if (deps.providerEnabled?.(input.provider, instance) === false)
    throw new AgentControlError("provider_disabled", "Selected account is disabled");
}

/**
 * An Antigravity account chosen by id. It is stored as an ACP account, so native scheduling never
 * picks it; an explicit choice is honoured when the account is still Antigravity's and its home
 * is usable. Its authentication is checked against the selected model like any other.
 */
function antigravityAccount(deps: DelegationDependencies, accountId: string) {
  const account = deps.accounts?.get(accountId);
  if (!account || accountProvider(account.instance) !== "antigravity")
    throw unavailable(`No Antigravity account has "${accountId}" as its id`);
  if (account.quota.blockers.homeUnavailable)
    throw unavailable(refused(deps, "antigravity", account, { reason: "home_unavailable" }, 0));
  return account.instance;
}

/** The account someone named, or the reason it can't run the work. */
function admitted(
  deps: DelegationDependencies,
  request: Parameters<typeof explicitInstance>[0],
  candidate: Candidate,
  now: number,
) {
  const result = explicitInstance(request, candidate, now);
  if ("refusal" in result)
    throw unavailable(
      accountLaunchRefusal(
        deps.accounts?.list() ?? [],
        candidate.instance.id,
        now,
        (id) => deps.providerEnabled?.(request.provider, id) !== false,
      ) ?? refused(deps, request.provider, candidate, result.refusal, now),
    );
  return result.instance;
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
  const accountId = namedAccountId(deps, input);
  const candidates = provider.success
    ? (deps.accounts
        ?.list()
        .filter(
          (entry) =>
            entry.instance.provider === provider.data &&
            (accountId ? entry.instance.id === accountId : !entry.instance.implicit),
        ) ?? [])
    : [];
  const request = {
    provider: provider.success ? provider.data : ("acp" as const),
    role: input.role,
    estimatedLoad: input.estimatedLoad,
  };
  const views: Candidate[] = [];
  // Why accounts lacked the model, reported when none has it: "no account" would hide the reason.
  let missing: AgentControlError | undefined;
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
      missing ??= error;
    }
  }
  // Only a model the agent named makes "it isn't there" the reason; otherwise the account is.
  if (missing && !views.length && input.model && !isDefaultSelection(input.model)) throw missing;
  const selected =
    input.provider === "antigravity" && accountId
      ? antigravityAccount(deps, accountId)
      : accountId && views[0]
        ? admitted(deps, request, views[0], now)
        : pickInstance(request, views, now);
  if (provider.success && !selected && (accountId || candidates.length)) {
    const words = providerNames[input.provider];
    const named = candidates[0];
    if (accountId && !named) throw unavailable(`No ${words} account has "${accountId}" as its id`);
    // An account that can't work at all says so before it is asked which models it serves.
    const blocked = candidates.flatMap((candidate) => {
      const refusal = definiteRefusal(request.provider, candidate, now);
      return refusal ? [refused(deps, input.provider, candidate, refusal, now)] : [];
    });
    if (!views.length && named && accountId)
      throw unavailable(
        blocked[0] ?? `${accountName(input.provider, named)} serves no model for this request`,
      );
    if (!views.length)
      throw unavailable(
        blocked.length === candidates.length
          ? `No ${words} account can take work: ${blocked.join("; ")}`.slice(0, 256)
          : `No ${words} account serves a model for this request`,
      );
    const reasons = views.map((view) =>
      refused(deps, input.provider, view, automaticRefusal(request.provider, view, now), now),
    );
    throw unavailable(`No ${words} account can take work: ${reasons.join("; ")}`.slice(0, 256));
  }
  const instance =
    selected?.id ??
    input.instanceId ??
    (input.provider === "cursor" ? cursorDefaultInstanceId : `${input.provider}-cli-default`);
  const model = selectedDelegationModel(deps.models, input, parent, instance, configured);
  checkAuth(deps, input, model, instance, now);
  const resolvedEffort = delegationEffort(model, input, parent);
  return {
    ...(selected ? { accountId: selected.id } : {}),
    resolvedModel: executionModelId(model),
    ...(resolvedEffort ? { resolvedEffort } : {}),
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
  checkAuth(deps, input, resolved.model, instance, now);
  if (!accountId) return;
  if (input.provider === "antigravity") {
    antigravityAccount(deps, accountId);
    return;
  }
  const account = deps.accounts?.get(accountId);
  if (!account)
    throw unavailable(`No ${providerNames[input.provider]} account has "${accountId}" as its id`);
  admitted(
    deps,
    { provider: account.instance.provider, role: input.role, estimatedLoad: input.estimatedLoad },
    eligible(deps, account, resolved.model),
    now,
  );
}
