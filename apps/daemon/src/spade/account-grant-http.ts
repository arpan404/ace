import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { grantLifetimeMs } from "@ace/account-grant";
import { AceAccountError } from "@ace/client/ace-account";
import { hostId } from "@ace/secure-channel";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import type { MachineAccount } from "../account-access/machine-account.ts";

export const accountGrantPath = "/spade/account-grant";

/** A fresh machine grant and the account it names; undefined while this machine is signed out. */
export type SpadeAccountGrant = (
  signal: AbortSignal,
) => Promise<{ token: string; account: string } | undefined>;

export interface AccountGrantHttpOptions {
  /** Whether a bearer is Spade's live grant (ADR 0123). */
  verify(bearer: string): boolean;
  grant: SpadeAccountGrant;
}

/**
 * `POST <daemon>/spade/account-grant` on the loopback listener (ADR 0139): Spade, with its grant,
 * gets a short-lived machine grant for this machine's ace account to show Spade Cloud. The same
 * grant the relay takes (ADR 0111); nothing is kept. Signed out answers 409 `signed_out`, so
 * Spade can say "Sign in to ace".
 */
export function accountGrantHttp(options: AccountGrantHttpOptions) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (!bearer || !options.verify(bearer)) return answer(response, 401, { error: "unauthorized" });
    if (request.method !== "POST") return answer(response, 405, { error: "method not allowed" });
    request.resume();
    const lifetime = new AbortController();
    response.on("close", () => lifetime.abort());
    void options.grant(lifetime.signal).then(
      (granted) => {
        if (!granted) return answer(response, 409, { error: "signed_out" });
        answer(response, 200, {
          token: granted.token,
          account: granted.account,
          expiresInMs: grantLifetimeMs(granted.token) ?? 0,
        });
      },
      (error: unknown) => {
        // The backend no longer knows this machine's session: signed out, as far as Spade is concerned.
        const signedOut = error instanceof AceAccountError && error.status === 401;
        answer(response, signedOut ? 409 : 502, {
          error: signedOut ? "signed_out" : "unreachable",
        });
      },
    );
  };
}

/** Machine grants from this daemon's ace session, for its relay host id. */
export function machineGrantSource(account: MachineAccount, dataDir: string): SpadeAccountGrant {
  return async (signal) => {
    const signedIn = account.account();
    if (!signedIn) return undefined;
    const keys = await loadOrCreateHostKeys(join(dataDir, "relay"));
    const token = await account.machineGrant(hostId(keys.publicKey), signal);
    return { token, account: signedIn.id };
  };
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
