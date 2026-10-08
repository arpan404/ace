import {
  ProviderAccountsRequest,
  ProviderAccountSummary,
  type ClientMessage,
  type ServerMessage,
} from "@ace/protocol";
import type { AccountSummary } from "@ace/protocol/accounts";
import type { FakeProviderLogin } from "../provider-login.ts";

import { fakeApiKeySupport } from "../provider-auth-support.ts";
export function fakeProviderAccounts(
  message: ClientMessage,
  options: {
    accounts(): AccountSummary[];
    replace(accounts: AccountSummary[]): void;
    id(): string;
    now(): number;
    login: FakeProviderLogin;
    owner: string;
    push(message: ServerMessage): void;
  },
): boolean {
  const parsed = ProviderAccountsRequest.safeParse(message);
  if (!parsed.success) return false;
  const request = parsed.data;
  const apiKey = fakeApiKeySupport(request.provider);
  const fail = (error: "unsupported" | "not_found" | "failed") =>
    options.push({
      type: "provider.accounts.result",
      requestId: request.requestId,
      result: { ok: false, error },
    });
  let instanceId = "instanceId" in request ? request.instanceId : undefined;
  const accounts = [...options.accounts()];
  if (request.type === "provider.accounts.add") {
    if (
      request.method === "api_key" &&
      (!apiKey.supported || (request.provider === "opencode" && !request.upstream))
    ) {
      fail("unsupported");
      return true;
    }
    instanceId = options.id();
    accounts.push({
      id: instanceId,
      provider: request.provider,
      label: request.label ?? "New account",
      implicit: false,
      isDefault: false,
      authMethod: "unknown",
      availability: "logged_out",
      quota: {
        auth: "logged_out",
        observedAt: options.now(),
        windows: {},
        blockers: {},
        usage: {},
      },
    });
  }
  const account = accounts.find(
    (row) => row.id === instanceId && row.provider === request.provider,
  );
  if (request.type !== "provider.accounts.list" && !account) {
    fail("not_found");
    return true;
  }
  if (request.type === "provider.accounts.add" || request.type === "provider.accounts.reauth") {
    if (
      request.method === "api_key" &&
      (!apiKey.supported || (request.provider === "opencode" && !request.upstream))
    ) {
      fail("unsupported");
      return true;
    }
    options.login.handle(
      {
        type: "provider.login.start",
        requestId: request.requestId,
        provider: request.provider,
        instance: instanceId,
        method: request.method,
        upstream: request.upstream,
      },
      options.owner,
      options.push,
      (result) => {
        if (result.type !== "provider.login.result") {
          options.push(result);
          return;
        }
        options.push({
          type: "provider.accounts.result",
          requestId: request.requestId,
          result: result.result.ok
            ? { ok: true, accounts: rows(), apiKey, progress: result.result.progress }
            : { ok: false, error: "failed", instanceId },
        });
      },
      (state) => {
        if (request.type === "provider.accounts.add" && state === "succeeded" && account)
          options.replace([...options.accounts(), account]);
      },
    );
    return true;
  }
  if (request.type === "provider.accounts.rename" && account) {
    if (account.implicit) {
      fail("failed");
      return true;
    }
    account.label = request.label;
    if (request.shortLabel !== undefined) account.shortLabel = request.shortLabel;
    if (request.badgeColor === null) delete account.badgeColor;
    else if (request.badgeColor !== undefined) account.badgeColor = request.badgeColor;
  }
  if (request.type === "provider.accounts.setDefault" && account)
    for (const row of accounts)
      if (row.provider === request.provider) row.isDefault = row === account;
  if (request.type === "provider.accounts.remove" && account) {
    if (options.login.scenarios[request.provider] === "failure") {
      fail("failed");
      return true;
    }
    if (request.deleteHome && ["pi", "opencode"].includes(request.provider)) {
      fail("unsupported");
      return true;
    }

    if (account.implicit) {
      fail("failed");
      return true;
    }
    options.replace(accounts.filter((row) => row !== account));
    if (account.isDefault) {
      const fallback = options
        .accounts()
        .find((row) => row.provider === request.provider && row.implicit);
      if (fallback) fallback.isDefault = true;
    }
  }
  options.push({
    type: "provider.accounts.result",
    requestId: request.requestId,
    result: { ok: true, accounts: rows(), apiKey },
  });
  return true;
  function rows() {
    return options
      .accounts()
      .filter((row) => row.provider === request.provider)
      .map((row) =>
        ProviderAccountSummary.parse({
          ...row,
          authMethod: row.authMethod ?? "unknown",
          status: row.availability,
          usageSummary: row.quota.usage,
          apiKey,
        }),
      );
  }
}
