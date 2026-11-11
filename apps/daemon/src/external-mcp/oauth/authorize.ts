/*
 * The authorization endpoint (OAuth 2.1 §4.1, ADR 0122 Consent). GET /authorize checks the
 * request, opens a sign-in request for the person in ace and sends the browser to a waiting page
 * whose URL alone carries its state (ace's relay sandbox allows no cookies or storage). The
 * person's answer in ace makes the grant and the code; the waiting page then redirects to the
 * client with `code`, `state` and `iss`, or with `error=access_denied`. Every redirect carries
 * `iss`; a request whose client or redirect URI can't be trusted is never redirected.
 */
import { OutsideScope } from "@ace/protocol";
import type { AccessOutcome } from "../access-requests.ts";
import type { OutsideAccess } from "../outside.ts";
import { normalScopes } from "../scopes.ts";
import type { RandomBytes } from "../tokens.ts";
import { namesResource, resourceOf, type OutsideBase } from "./base.ts";
import type { ClientProblem, OAuthClient } from "./client.ts";
import { challengeShape, codeTtlMs, type AuthorizationCodes } from "./codes.ts";
import { consentPage, endedPage, pageHeaders, type ConsentView } from "./consent-page.ts";
import { baselineScopes } from "./metadata.ts";
import { matchRedirect, redirectTarget } from "./redirects.ts";

/** Sign-ins waiting at once: in all, per client, and per way in (base URL). */
export const pendingLimits = { total: 64, perClient: 3, perBase: 16 };
/**
 * A waiting page reloads every two seconds; one silent this long was closed, and its request
 * leaves the person's list. Generous because a phone suspends the browser while the person
 * switches to ace to approve; the per-client and per-base limits are what stop floods.
 */
export const abandonedAfterMs = 3 * 60_000;

export interface AuthorizeDeps {
  outside: Pick<OutsideAccess, "grants" | "requests" | "principals">;
  clients: {
    resolve(clientId: string): Promise<OAuthClient | ClientProblem>;
    /** The client was approved for a grant (keeps a DCR registration from expiring). */
    approved(client: OAuthClient): void;
  };
  codes: AuthorizationCodes;
  random: RandomBytes;
  now: () => number;
  after: (ms: number, run: () => void) => () => void;
  /** The machine's name, as the person knows it. */
  machine(): string;
  /** A note for the daemon log; never a code, token or state. */
  note?: (text: string) => void;
}

type Waiting = {
  kind: "waiting";
  view: ConsentView;
  requestId: string;
  clientId: string;
  base: string;
  /** When the waiting page last loaded. */
  seen: number;
};
type Done = { kind: "done"; location: string };

/** The requested scopes ace knows; unknown ones are left out, none means reading. */
export function requestedScopes(scope: string | null): OutsideScope[] {
  const known = (scope ?? "").split(" ").flatMap((name) => {
    const parsed = OutsideScope.safeParse(name);
    return parsed.success ? [parsed.data] : [];
  });
  return normalScopes(known.length ? known : baselineScopes);
}

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: pageHeaders });
}
function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
/** The client's redirect URI with the authorization response (RFC 9207: always `iss`). */
function responseUrl(
  redirectUri: string,
  base: OutsideBase,
  state: string | null,
  fields: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", base.url);
  return url.href;
}

export class Authorizations {
  private pending = new Map<string, Waiting | Done>();
  private deps: AuthorizeDeps;
  constructor(deps: AuthorizeDeps) {
    this.deps = deps;
  }
  /** GET /authorize at `base`. */
  async start(query: URLSearchParams, base: OutsideBase): Promise<Response> {
    const machine = this.deps.machine();
    const fail = (sentence: string) => html(400, endedPage(machine, sentence, true));
    const clientId = query.get("client_id");
    if (!clientId) return fail("The sign-in link has no client_id.");
    const client = await this.deps.clients.resolve(clientId);
    if ("problem" in client) return fail(client.problem);
    const asked = query.get("redirect_uri");
    const redirectUri = asked ? matchRedirect(asked, client.redirectUris) : undefined;
    if (!redirectUri)
      return fail(`${client.name} asked to return to an address it didn't register.`);
    // From here on, errors go back to the client.
    const state = query.get("state");
    const refuse = (error: string, description: string) =>
      redirect(responseUrl(redirectUri, base, state, { error, error_description: description }));
    if (query.get("response_type") !== "code")
      return refuse("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = query.get("code_challenge") ?? "";
    if (query.get("code_challenge_method") !== "S256" || !challengeShape.test(challenge))
      return refuse("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    const resource = query.get("resource");
    if (!resource || !namesResource(resource, base))
      return refuse("invalid_target", `resource must be ${resourceOf(base)}.`);
    if (!this.room(client.clientId, base.url))
      return refuse("temporarily_unavailable", "Too many sign-ins are waiting. Try again soon.");
    const scopes = requestedScopes(query.get("scope"));
    const target = redirectTarget(redirectUri);
    // Every sign-in is its own grant. A metadata document's client_id is shared by everyone who
    // uses that app, so it never says whose grant to widen; the person widens one in ace.
    let opened: ReturnType<AuthorizeDeps["outside"]["requests"]["open"]>;
    try {
      opened = this.deps.outside.requests.open({
        clientName: client.name,
        domain: client.domain,
        scopes,
        ...target,
      });
    } catch {
      return refuse("temporarily_unavailable", "Too many sign-ins are waiting. Try again soon.");
    }
    const key = this.deps.random(32).toString("base64url");
    const waiting: Waiting = {
      kind: "waiting",
      requestId: opened.request.requestId,
      clientId: client.clientId,
      base: base.url,
      seen: this.deps.now(),
      view: {
        clientName: client.name,
        domain: client.domain,
        ...target,
        scopes,
        matchCode: opened.request.matchCode,
        machine,
      },
    };
    this.pending.set(key, waiting);
    this.watchPage(key, waiting);
    void opened.outcome.then((outcome) => {
      let location: string;
      try {
        location = this.answer(outcome, { client, redirectUri, challenge, base, state });
      } catch {
        location = responseUrl(redirectUri, base, state, {
          error: "server_error",
          error_description: "ace couldn't save this sign-in.",
        });
      }
      this.pending.set(key, { kind: "done", location });
      // The code is good for a minute; past it the page has nothing left to give.
      this.deps.after(codeTtlMs, () => this.pending.delete(key));
    });
    return redirect(`${base.url}/authorize/wait?${new URLSearchParams({ k: key })}`);
  }
  /** Turns the person's answer into the redirect: a grant and its code, or a refusal. */
  private answer(
    outcome: AccessOutcome,
    request: {
      client: OAuthClient;
      redirectUri: string;
      challenge: string;
      base: OutsideBase;
      state: string | null;
    },
  ): string {
    const { client, redirectUri, challenge, base, state } = request;
    {
      let location: string;
      if (outcome.decision === "approve") {
        const grant = this.deps.outside.grants.create({
          clientKind: client.kind,
          clientId: client.clientId,
          name: client.name,
          domain: client.domain,
          scopes: outcome.scopes,
          projects: outcome.projects,
          expiresAt: outcome.expiresAt,
          approvedBy: outcome.by,
        });
        this.deps.clients.approved(client);
        this.deps.outside.principals.watch([grant]);
        const code = this.deps.codes.issue({
          grantId: grant.id,
          clientId: client.clientId,
          redirectUri,
          challenge,
          resource: resourceOf(base),
        });
        this.deps.note?.(`Outside client ${client.name} (${grant.id}) approved by ${outcome.by}.`);
        location = responseUrl(redirectUri, base, state, { code });
      } else {
        location = responseUrl(redirectUri, base, state, {
          error: "access_denied",
          error_description:
            outcome.decision === "deny"
              ? "The person denied this sign-in in ace."
              : "Nobody approved this sign-in in time.",
        });
      }
      return location;
    }
  }
  /** GET /authorize/wait: the waiting page, or the redirect once the person decided. */
  wait(query: URLSearchParams): Response {
    const entry = this.pending.get(query.get("k") ?? "");
    if (!entry)
      return html(
        404,
        endedPage(
          this.deps.machine(),
          "This sign-in has ended. Start again from the app you were signing in to.",
          false,
        ),
      );
    if (entry.kind === "done") return redirect(entry.location);
    entry.seen = this.deps.now();
    return html(200, consentPage(entry.view));
  }
  /** Whether another sign-in may wait, from this client at this base. */
  private room(clientId: string, base: string): boolean {
    let all = 0;
    let client = 0;
    let atBase = 0;
    for (const entry of this.pending.values()) {
      if (entry.kind !== "waiting") continue;
      all++;
      if (entry.clientId === clientId) client++;
      if (entry.base === base) atBase++;
    }
    return (
      all < pendingLimits.total &&
      client < pendingLimits.perClient &&
      atBase < pendingLimits.perBase
    );
  }
  /** Cancels the request once its page stops reloading: nobody is there to be redirected. */
  private watchPage(key: string, entry: Waiting): void {
    const check = () => {
      if (this.pending.get(key) !== entry) return;
      const quiet = this.deps.now() - entry.seen;
      if (quiet >= abandonedAfterMs) this.deps.outside.requests.cancel(entry.requestId);
      else this.deps.after(abandonedAfterMs - quiet, check);
    };
    this.deps.after(abandonedAfterMs, check);
  }
}
