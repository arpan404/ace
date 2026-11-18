import {
  AceAccountGrant,
  AceMachineCredentialRequest,
  AceMachineEnrollmentRequest,
} from "@ace/protocol/ace-account";
import { decodeBase64url } from "@ace/account-grant";
import { machineCredentialProofValid } from "@ace/account-grant/machine-proof";
import { hostId as hostIdOf } from "@ace/secure-channel";
import { digest, opaqueToken } from "./crypto.ts";
import type { RandomBytes } from "./crypto.ts";
import type { MachineCredentialStore } from "./credentials.ts";
import { ENROLLMENT_LIFETIME_MS, type EnrollmentStore } from "./enrollments.ts";
import type { PrincipalReader } from "./principal.ts";
import { bearer, fail, json, jsonBody } from "./respond.ts";
import type { SessionReader } from "./session.ts";
import type { SessionStore } from "./sessions.ts";

/**
 * Machine sign-in (ADR 0190).
 *
 * - `POST /v1/machine-enrollments`, the person's session: a single-use ticket for one host id.
 *   The app hands its daemon this, never its session.
 * - `POST /v1/machine-credentials`: a daemon redeems a ticket, or exchanges a session it holds
 *   itself (`ace login`, an old session file), for a credential of its machine's own. It proves
 *   the host key the host id names, as `/host` does with Noise, and chooses the credential itself,
 *   writing it to disk first, so an answer lost on the way is recovered by retrying or using it.
 *
 * Issuing is one D1 batch, in order: mark the session exposed when it was kept on a disk, issue
 * the credential only while the session's token or the ticket can still issue it, then retire
 * the token (`sole`) or spend the ticket. No grant decision reads a standing from before it.
 */
export function machineSignInRoutes(deps: {
  db: D1Database;
  principals: PrincipalReader;
  sessions: SessionReader;
  sessionStore: Pick<SessionStore, "exposing" | "retiring">;
  credentials: MachineCredentialStore;
  enrollments: EnrollmentStore;
  exchangeKey: { privateKey: Uint8Array };
  now: () => number;
  random: RandomBytes;
}) {
  const { principals, sessions, credentials, enrollments, now } = deps;
  const answer = (
    status: number,
    token: string,
    session: { account: AceAccountGrant["account"]; expiresAt: number },
  ) =>
    json(
      status,
      AceAccountGrant.parse({ token, expiresAt: session.expiresAt, account: session.account }),
    );
  return {
    async enroll(request: Request): Promise<Response> {
      const token = bearer(request);
      const principal = token ? await principals.read(token) : undefined;
      if (!principal) return fail(401, "unauthenticated");
      if (principal.kind === "machine") return fail(403, "machine_credential");
      const parsed = AceMachineEnrollmentRequest.safeParse(await jsonBody(request, 1024));
      if (!parsed.success) return fail(400, "invalid_request");
      const ticket = opaqueToken(deps.random);
      const expiresAt = now() + ENROLLMENT_LIFETIME_MS;
      await enrollments.put(await digest(ticket), {
        session: principal.hash,
        hostId: parsed.data.hostId,
        accountId: principal.account.id,
        expiresAt,
      });
      return json(201, { ticket, expiresAt });
    },

    async exchange(request: Request): Promise<Response> {
      const parsed = AceMachineCredentialRequest.safeParse(await jsonBody(request, 4096));
      if (!parsed.success) return fail(400, "invalid_request");
      const body = parsed.data;
      let hostKeyMatches = false;
      try {
        hostKeyMatches = hostIdOf(decodeBase64url(body.hostKey)) === body.hostId;
      } catch {
        hostKeyMatches = false;
      }
      if (
        !hostKeyMatches ||
        !machineCredentialProofValid({
          exchangePrivateKey: deps.exchangeKey.privateKey,
          hostKey: body.hostKey,
          hostId: body.hostId,
          credential: body.credential,
          proof: body.proof,
        })
      )
        return fail(403, "host_key");
      const hash = await digest(body.credential);
      // A retry after a lost answer: the credential was issued already.
      const issued = await principals.read(body.credential);
      if (issued)
        return issued.kind === "machine" && issued.hostId === body.hostId
          ? answer(200, body.credential, issued)
          : fail(409, "conflict");

      let from: { session: string } | { ticket: string };
      let session;
      let parent: string;
      let exposed = body.exposed === true;
      if (body.ticket !== undefined) {
        const ticketHash = await digest(body.ticket);
        const ticket = await enrollments.get(ticketHash, now());
        if (!ticket) return fail(401, "invalid_ticket");
        if (ticket.hostId !== body.hostId) return fail(403, "other_machine");
        session = await sessions.readHash(ticket.session);
        if (!session || session.account.id !== ticket.accountId) return fail(401, "invalid_ticket");
        from = { ticket: ticketHash };
        parent = ticket.session;
      } else {
        const token = bearer(request);
        const principal = token ? await principals.read(token) : undefined;
        if (!principal) return fail(401, "unauthenticated");
        if (principal.kind === "machine") return fail(403, "machine_credential");
        session = principal;
        from = { session: principal.hash };
        parent = principal.hash;
        // A session from before standing was kept is only ever exchanged from a session file.
        exposed ||= principal.standing === "legacy";
      }
      const sole = body.sole === true && "session" in from;
      const results = await deps.db.batch([
        ...(exposed ? [deps.sessionStore.exposing(parent)] : []),
        credentials.inserting(
          hash,
          {
            session: parent,
            hostId: body.hostId,
            accountId: session.account.id,
            expiresAt: session.expiresAt,
            sole,
          },
          now(),
          from,
        ),
        ...(sole ? [deps.sessionStore.retiring(parent)] : []),
        ...("ticket" in from ? [enrollments.spending(from.ticket)] : []),
      ]);
      const inserted = results[exposed ? 1 : 0];
      if (!inserted || inserted.meta.changes === 0) {
        // Another exchange won the session or ticket; the same credential's own retry is fine.
        const again = await principals.read(body.credential);
        return again?.kind === "machine"
          ? answer(200, body.credential, again)
          : fail(401, "unauthenticated");
      }
      return answer(201, body.credential, session);
    },
  };
}
