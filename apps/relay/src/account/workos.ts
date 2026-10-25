import { WorkOS } from "@workos-inc/node";
import { AceAccount } from "@ace/protocol/ace-account";
import type { AccountConfig } from "./config.ts";

export interface AccountIdentity {
  account: AceAccount;
  refreshToken: string;
}
export interface AccountProvider {
  authorize(): Promise<{ url: string; state: string; codeVerifier: string }>;
  exchange(code: string, verifier: string): Promise<AccountIdentity>;
  refresh(token: string): Promise<AccountIdentity>;
}

export function workosProvider(config: AccountConfig): AccountProvider {
  const workos = new WorkOS(config.apiKey, { clientId: config.clientId, timeout: 10_000 });
  const identity = (
    result: Awaited<ReturnType<typeof workos.userManagement.authenticateWithCode>>,
  ) => ({
    account: AceAccount.parse({
      id: result.user.id,
      email: result.user.email,
      name: [result.user.firstName, result.user.lastName].filter(Boolean).join(" "),
    }),
    refreshToken: result.refreshToken,
  });
  return {
    authorize: () =>
      workos.userManagement.getAuthorizationUrlWithPKCE({
        provider: "authkit",
        clientId: config.clientId,
        redirectUri: `${config.publicUrl}/v1/account/callback`,
      }),
    async exchange(code, codeVerifier) {
      return identity(
        await workos.userManagement.authenticateWithCode({
          clientId: config.clientId,
          code,
          codeVerifier,
        }),
      );
    },
    async refresh(refreshToken) {
      return identity(
        await workos.userManagement.authenticateWithRefreshToken({
          clientId: config.clientId,
          refreshToken,
        }),
      );
    },
  };
}
