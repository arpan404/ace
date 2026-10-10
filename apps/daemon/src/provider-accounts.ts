import {
  ProviderAccountsRequest,
  ProviderAccountsResult,
  type ProviderAccountSummary,
} from "@ace/protocol";
import type { AccountManagement } from "./account-management.ts";
import type { ProviderLoginSessions } from "@ace/accounts";

/** Additive provider-page contract. Registration, homes and login remain with their existing owners. */
export async function providerAccounts(
  management: AccountManagement,
  login: ProviderLoginSessions,
  owner: string,
  input: ProviderAccountsRequest,
): Promise<ProviderAccountsResult> {
  const request = ProviderAccountsRequest.parse(input);
  const apiKey = await management.apiKeySupport(request.provider);
  const fail = (
    error: "unsupported" | "not_found" | "failed",
    instanceId?: string,
  ): ProviderAccountsResult => ({
    type: "provider.accounts.result",
    requestId: request.requestId,
    result: { ok: false, error, ...(instanceId ? { instanceId } : {}) },
  });
  let progress: import("@ace/protocol").ProviderLoginProgress | undefined;
  if (request.type !== "provider.accounts.list") {
    let instanceId: string;
    if (request.type === "provider.accounts.add") {
      if (
        request.method === "api_key" &&
        (!apiKey.supported || (request.provider === "opencode" && !request.upstream))
      )
        return fail("unsupported");
      instanceId = await management.addPending(
        request.provider,
        request.label ?? "New account",
        request.shortLabel,
      );
    } else {
      instanceId = request.instanceId;
      const account = management.summaries(request.provider).find((row) => row.id === instanceId);
      if (!account) return fail("not_found");
      if (request.type === "provider.accounts.remove" && account.implicit) return fail("failed");
    }
    if (request.type === "provider.accounts.add" || request.type === "provider.accounts.reauth") {
      if (
        request.method === "api_key" &&
        (!apiKey.supported || (request.provider === "opencode" && !request.upstream))
      )
        return fail("unsupported", instanceId);
      const result = await login.handle(
        owner,
        {
          type: "provider.login.start",
          requestId: request.requestId,
          provider: request.provider,
          instance: instanceId,
          method: request.method,
          ...(request.upstream ? { upstream: request.upstream } : {}),
        },
        request.type === "provider.accounts.add"
          ? (state) => management.finishPending(instanceId, state)
          : undefined,
      );
      if (!result.result.ok) {
        if (request.type === "provider.accounts.add")
          await management.finishPending(instanceId, "failed");
        return fail("failed", instanceId);
      }
      progress = result.result.progress;
    } else if (request.type === "provider.accounts.remove") {
      // These providers expose reviewed unattended logout. A failed logout retains metadata/home.
      if (["codex", "claude", "cursor"].includes(request.provider)) {
        const result = await login.handle(owner, {
          type: "provider.logout",
          requestId: request.requestId,
          provider: request.provider,
          instance: instanceId,
        });
        if (
          !result.result.ok ||
          (await login.completed(owner, result.result.progress.session)).state !== "succeeded"
        )
          return fail("failed", instanceId);
      } else if (request.deleteHome) return fail("unsupported", instanceId);
      await management.handle(owner, {
        type: "accounts.remove",
        requestId: request.requestId,
        instanceId,
        deleteHome: request.deleteHome,
      });
    } else {
      await management.handle(owner, {
        ...request,
        type:
          request.type === "provider.accounts.rename" ? "accounts.rename" : "accounts.setDefault",
      });
    }
  }
  const accounts: ProviderAccountSummary[] = management.summaries(request.provider).map((account) =>
    Object.assign({}, account, {
      authMethod: account.authMethod ?? "unknown",
      status: account.availability,
      apiKey,
      usageSummary: account.quota.usage,
    }),
  );
  return ProviderAccountsResult.parse({
    type: "provider.accounts.result",
    requestId: request.requestId,
    result: { ok: true, accounts, apiKey, ...(progress ? { progress } : {}) },
  });
}
