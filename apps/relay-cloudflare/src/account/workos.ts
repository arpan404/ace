import { z } from "zod";
import { AceAccount } from "@ace/protocol/ace-account";
import type { AccountConfig } from "./config.ts";

export interface AccountIdentity {
  account: AceAccount;
  refreshToken: string;
  /** Where WorkOS keeps the person's picture (an https address); kept by the backend only. */
  pictureUrl?: string | undefined;
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
    profile_picture_url: z.string().nullish(),
  }),
  refresh_token: z.string().min(1),
});
const Failure = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

/**
 * One line per WorkOS refusal: its status and error code, the public client id, and the API
 * key's shape (test or live, length, stray whitespace), never the key, tokens, codes or users.
 */
function logRefusal(status: number, raw: unknown, config: AccountConfig): void {
  const failure = Failure.safeParse(raw);
  const data = failure.success ? failure.data : {};
  console.warn(
    JSON.stringify({
      event: "workos_authenticate_refused",
      status,
      error: data.error ?? data.code,
      description: (data.error_description ?? data.message)?.slice(0, 200),
      clientId: config.clientId,
      key: {
        kind: config.apiKey.startsWith("sk_live_")
          ? "live"
          : config.apiKey.startsWith("sk_test_")
            ? "test"
            : config.apiKey.startsWith("sk_")
              ? "sk"
              : "other",
        length: config.apiKey.length,
        whitespace: /\s/.test(config.apiKey),
      },
    }),
  );
}

/** An https address WorkOS gave (or a loopback http one, as tests run), else undefined. */
function httpsUrl(value: string | null | undefined): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    return url.protocol === "https:" || loopback ? value : undefined;
  } catch {
    return undefined;
  }
}

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
      logRefusal(response.status, raw, config);
      const failure = Failure.safeParse(raw);
      if (
        (response.status === 400 || response.status === 401) &&
        failure.success &&
        (failure.data.error === "invalid_grant" || failure.data.code === "invalid_grant")
      )
        throw new InvalidGrantError("WorkOS rejected the grant");
      throw new Error(`WorkOS answered ${response.status}`);
    }
    const parsed = Authenticated.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        JSON.stringify({
          event: "workos_authenticate_unexpected",
          issues: parsed.error.issues.map((issue) => issue.path.join(".")).slice(0, 10),
        }),
      );
      throw new Error("WorkOS answered an unexpected shape");
    }
    const result = parsed.data;
    const pictureUrl = httpsUrl(result.user.profile_picture_url);
    return {
      account: AceAccount.parse({
        id: result.user.id,
        email: result.user.email,
        name: [result.user.first_name, result.user.last_name].filter(Boolean).join(" "),
        ...(pictureUrl ? { picture: true } : {}),
      }),
      refreshToken: result.refresh_token,
      pictureUrl,
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
