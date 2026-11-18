import { AceAccountGrant, AceMachineCredentialRequest } from "@ace/protocol/ace-account";
import { digest, opaqueToken } from "./crypto.ts";
import type { RandomBytes } from "./crypto.ts";
import type { MachineCredentialStore } from "./credentials.ts";
import type { PrincipalReader } from "./principal.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import type { SessionStore } from "./sessions.ts";

/**
 * POST /v1/machine-credentials (ADR 0190): a daemon exchanges an ace session for a credential
 * of its machine's own, bound to its host id, and keeps that instead. A credential can't be
 * exchanged again, and nothing it mints speaks for the person.
 *
 * - A session the daemon says it kept on its disk (`exposed`), or one from before standing was
 *   kept (`legacy`), which only a machine's session file exchanges, is marked `exposed`.
 * - `sole`: the daemon was the session's only holder. The session moves to a digest no token
 *   has, so its old token, and any copy of it, stops working.
 */
export function machineCredentialRoute(deps: {
  principals: PrincipalReader;
  sessionStore: Pick<SessionStore, "expose" | "retire">;
  credentials: MachineCredentialStore;
  now: () => number;
  random: RandomBytes;
}) {
  const { principals, sessionStore, credentials, now, random } = deps;
  return async (request: Request): Promise<Response> => {
    const token = bearer(request);
    const principal = token ? await principals.read(token) : undefined;
    if (!principal) return fail(401, "unauthenticated");
    if (principal.kind === "machine") return fail(403, "machine_credential");
    const parsed = AceMachineCredentialRequest.safeParse(await jsonBody(request, 4096));
    if (!parsed.success) return fail(400, "invalid_request");
    const { hostId, sole, exposed } = parsed.data;
    if (exposed === true || principal.standing === "legacy")
      await sessionStore.expose(principal.hash);
    let session = principal.hash;
    if (sole === true) {
      const next = await digest(opaqueToken(random));
      // Another reader is refreshing it right now: the daemon tries again on its next round.
      if (!(await sessionStore.retire(principal.hash, next, now()))) return fail(409, "busy");
      session = next;
    }
    const credential = opaqueToken(random);
    await credentials.put(
      await digest(credential),
      {
        session,
        hostId,
        accountId: principal.account.id,
        expiresAt: principal.expiresAt,
        sole: sole === true,
      },
      now(),
    );
    return json(
      201,
      AceAccountGrant.parse({
        token: credential,
        expiresAt: principal.expiresAt,
        account: principal.account,
      }),
    );
  };
}
