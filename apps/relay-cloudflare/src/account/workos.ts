import { z } from "zod";
import { AceAccount } from "@ace/protocol/ace-account";
import type { AccountConfig } from "./config.ts";

export interface AccountIdentity {
  account: AceAccount;
  refreshToken: string;
}

/** WorkOS said the refresh token or code is no longer valid: the session must end. */
export class InvalidGrantError extends Error {
  override name = "InvalidGrantError";
}

const Authenticated = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
  }),
  refresh_token: z.string().min(1),
});
const Failure = z.object({ error: z.string().optional(), code: z.string().optional() });

/**
 * WorkOS User Management over its REST API (the Node SDK is not used in the Worker).
 * `authorizeUrl` is AuthKit's authorization endpoint with PKCE; `exchange` and `refresh` are
 * `POST /user_management/authenticate` with the `authorization_code` and `refresh_token` grants.
 */
export function workos(config: AccountConfig, fetcher: typeof fetch) {
  const base = config.workosUrl;
  async function authenticate(body: Record<string, string>): Promise<AccountIdentity> {
    const response = await fetcher(`${base}/user_management/authenticate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.apiKey,
        ...body,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = Failure.safeParse(raw);
      if (
        (response.status === 400 || response.status === 401) &&
        failure.success &&
        (failure.data.error === "invalid_grant" || failure.data.code === "invalid_grant")
      )
        throw new InvalidGrantError("WorkOS rejected the grant");
      throw new Error(`WorkOS answered ${response.status}`);
    }
    const result = Authenticated.parse(raw);
    return {
      account: AceAccount.parse({
        id: result.user.id,
        email: result.user.email,
        name: [result.user.first_name, result.user.last_name].filter(Boolean).join(" "),
      }),
      refreshToken: result.refresh_token,
    };
  }
  return {
    authorizeUrl(challenge: string, state: string): string {
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${config.publicUrl}/v1/account/callback`,
        response_type: "code",
        provider: "authkit",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return `${base}/user_management/authorize?${query}`;
    },
    exchange: (code: string, verifier: string) =>
      authenticate({ grant_type: "authorization_code", code, code_verifier: verifier }),
    refresh: (refreshToken: string) =>
      authenticate({ grant_type: "refresh_token", refresh_token: refreshToken }),
  };
}
export type AccountProvider = ReturnType<typeof workos>;
