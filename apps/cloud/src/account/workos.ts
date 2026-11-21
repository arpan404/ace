import { z } from "zod";
import { AceAccount } from "@ace/protocol/ace-account";
import type { AccountConfig } from "./config.ts";

export interface AccountIdentity {
  account: AceAccount;
  refreshToken: string;
  /** Where WorkOS keeps the person's picture (an https address); kept by the backend only. */
  pictureUrl?: string | undefined;
  /** The organization the sign-in entered, when it entered one (an invitation, `org`). */
  organizationId?: string | undefined;
}

/** WorkOS said the refresh token or code is no longer valid: the session must end. */
export class InvalidGrantError extends Error {
  override name = "InvalidGrantError";
}

/**
 * WorkOS refused to refresh this session into an organization: not a member, or the
 * organization's sign-in policy (SSO, MFA) needs a sign-in this session didn't make. The session
 * itself is not ended for it: personal never depends on an organization (ADR 0206 §1.4).
 */
export class OrgRefusedError extends Error {
  override name = "OrgRefusedError";
  readonly code: string | undefined;
  constructor(code: string | undefined) {
    super("WorkOS refused the organization");
    this.code = code;
  }
}

/** What a refresh into an organization gave: the identity and its signed access token. */
export interface OrgIdentity extends AccountIdentity {
  accessToken: string;
}

const Authenticated = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    email_verified: z.boolean().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    profile_picture_url: z.string().nullish(),
  }),
  refresh_token: z.string().min(1),
  access_token: z.string().min(1).max(16_384).optional(),
  organization_id: z.string().max(128).nullish(),
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
  async function authenticate(
    body: Record<string, string>,
    org?: string,
  ): Promise<AccountIdentity & { accessToken?: string | undefined }> {
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
      // Into an organization, any refusal is the organization's: the session stays as it was,
      // and its next personal refresh says whether it is still good.
      if (org !== undefined && response.status >= 400 && response.status < 500)
        throw new OrgRefusedError(
          failure.success ? (failure.data.code ?? failure.data.error) : undefined,
        );
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
        emailVerified: result.user.email_verified === true,
        name: [result.user.first_name, result.user.last_name].filter(Boolean).join(" "),
        ...(pictureUrl ? { picture: true } : {}),
      }),
      refreshToken: result.refresh_token,
      pictureUrl,
      accessToken: result.access_token,
      organizationId: result.organization_id ?? undefined,
    };
  }
  return {
    /**
     * `org`: sign in to enter one organization, under its sign-in policy (ADR 0206 §1.4).
     * `invitation`: accept a WorkOS invitation by signing in (the join page).
     */
    authorizeUrl(
      challenge: string,
      state: string,
      extra: { org?: string | null | undefined; invitation?: string | undefined } = {},
    ): string {
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${config.publicUrl}/v1/account/callback`,
        response_type: "code",
        provider: "authkit",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      if (extra.org) query.set("organization_id", extra.org);
      if (extra.invitation) query.set("invitation_token", extra.invitation);
      return `${base}/user_management/authorize?${query}`;
    },
    exchange: (code: string, verifier: string) =>
      authenticate({ grant_type: "authorization_code", code, code_verifier: verifier }),
    refresh: (refreshToken: string) =>
      authenticate({ grant_type: "refresh_token", refresh_token: refreshToken }),
    /**
     * A refresh with `organization_id` (ADR 0206 §1.4): the access token's `org_id` and `role`
     * say the membership. Throws `OrgRefusedError` when WorkOS won't let the session in.
     */
    async refreshInto(refreshToken: string, org: string): Promise<OrgIdentity> {
      const identity = await authenticate(
        { grant_type: "refresh_token", refresh_token: refreshToken, organization_id: org },
        org,
      );
      if (!identity.accessToken) throw new Error("WorkOS answered without an access token");
      return { ...identity, accessToken: identity.accessToken };
    },
  };
}
export type AccountProvider = ReturnType<typeof workos>;
