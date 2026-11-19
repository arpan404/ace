import type { App, Client } from "./apps.ts";

/**
 * Requests to an app maker's token endpoint as the cloud's client, with its secret: exchanging a
 * code and refreshing. The answer goes on to Spade as the maker's JSON cut to the fields a token
 * response has; it is never logged or kept.
 */

/** The fields of a token response (RFC 6749 section 5.1, plus OpenID's `id_token`) passed on. */
const TOKEN_FIELDS = [
  "access_token",
  "token_type",
  "expires_in",
  "refresh_token",
  "scope",
  "id_token",
] as const;
const MOST_ANSWER_BYTES = 64 * 1024;
export const MAKER_TIMEOUT_MS = 10_000;

/**
 * `refused`: the maker refused the code or the refresh token, so the person must sign in again.
 * `upstream`: it couldn't be reached or answered something unusable.
 */
export type MakerResult =
  | { ok: true; tokens: Uint8Array }
  | { ok: false; why: "refused" | "upstream" };

export function maker(fetcher: typeof fetch) {
  async function token(app: App, client: Client, form: URLSearchParams): Promise<MakerResult> {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    });
    if (app.client_auth === "client_secret_basic") {
      // RFC 6749 section 2.3.1: the ID and secret are form-encoded before Basic.
      const pair = `${formEncode(client.id)}:${formEncode(client.secret)}`;
      headers.set("Authorization", `Basic ${base64(pair)}`);
    } else {
      form.set("client_id", client.id);
      form.set("client_secret", client.secret);
    }
    let response: Response;
    let bytes: Uint8Array;
    // Only the status is ever looked at on failure: an error's text may quote the request.
    try {
      response = await fetcher(app.token_endpoint, {
        method: "POST",
        headers,
        body: form.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(MAKER_TIMEOUT_MS),
      });
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return { ok: false, why: "upstream" };
    }
    if (response.status === 400 || response.status === 401) return { ok: false, why: "refused" };
    if (!response.ok || bytes.length > MOST_ANSWER_BYTES) return { ok: false, why: "upstream" };
    const tokens = tokenResponse(bytes);
    return tokens ? { ok: true, tokens } : { ok: false, why: "upstream" };
  }

  return {
    /** The authorization code grant with PKCE, back to `redirect`. */
    exchange(app: App, client: Client, code: string, verifier: string, redirect: string) {
      return token(
        app,
        client,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
          resource: app.resource,
        }),
      );
    },
    refresh(app: App, client: Client, refreshToken: string) {
      return token(
        app,
        client,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          resource: app.resource,
        }),
      );
    },
  };
}

/** The token fields of a successful answer, as JSON. One without an access token is unusable. */
export function tokenResponse(bytes: Uint8Array): Uint8Array | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined;
  const fields = new Map(Object.entries(answer));
  const access = fields.get("access_token");
  if (typeof access !== "string" || access === "") return undefined;
  const kept: Record<string, unknown> = {};
  for (const name of TOKEN_FIELDS) if (fields.has(name)) kept[name] = fields.get(name);
  return new TextEncoder().encode(JSON.stringify(kept));
}

function formEncode(text: string): string {
  return new URLSearchParams({ v: text }).toString().slice(2);
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
