import type { ClientApi } from "@ace/client";
import type { AceOrgClient } from "@ace/client/ace-org";
import { orgFailure } from "./org-copy.ts";

/** Why the machine wouldn't give its consent (`account.owner.enroll.result`), in words. */
const refusals: Record<string, string> = {
  not_owner: "Only this machine's owner, signed in here, can give it to an organization.",
  signed_out: "Sign this machine in to your ace account first.",
  unavailable: "This machine couldn't reach your ace account. Try again.",
};

export class EnrollRefused extends Error {}

/**
 * Gives the window's own machine to `org` (ADR 0206 §2.1): the machine's daemon gives its consent
 * to this connection, which proved the owner's standing (ADR 0190); the backend enrolls it with
 * that consent, spent once; the daemon checks with the backend and then answers to the
 * organization. Every person's standing on it ends; nothing on its disk is deleted.
 */
export async function enrollThisMachine(deps: {
  daemon: Pick<ClientApi, "request">;
  orgs: Pick<AceOrgClient, "enrollHost">;
  token: string;
  org: string;
  /** Proves the owner's standing again on this connection, as a person-only write does. */
  withStanding<T>(send: () => Promise<T>, refused: (result: T) => boolean): Promise<T>;
}): Promise<void> {
  const asked = await deps.withStanding(
    () => deps.daemon.request({ type: "account.owner.enroll", org: deps.org }),
    (reply) => !reply.result.ok && reply.result.code === "not_owner",
  );
  if (!asked.result.ok)
    throw new EnrollRefused(refusals[asked.result.code] ?? asked.result.message);
  const { consent } = asked.result;
  try {
    await deps.orgs.enrollHost(
      deps.token,
      deps.org,
      { hostId: consent.hostId, consent },
      AbortSignal.timeout(15_000),
    );
  } catch (error) {
    throw new EnrollRefused(orgFailure(error));
  }
  const confirmed = await deps.daemon.request({
    type: "account.owner.enroll.confirm",
    org: deps.org,
  });
  if (!confirmed.ok)
    throw new EnrollRefused(
      "The organization holds this machine, but it hasn't switched over yet. Restart ace on it.",
    );
}
