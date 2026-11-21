import { z } from "zod";
import { signRegistryKeyAttestation, type GrantSigningKey } from "@ace/account-grant";
import type { OrgAccess } from "./org-access.ts";
import { fail, json, jsonBody } from "./respond.ts";

/*
 * An organization's private registry, as the account backend vouches for it (ADR 0206 §5.3):
 * an owner adding a key to the registry's chain gets the backend's attestation of that key's
 * exact upload, from the person's own session and a fresh WorkOS answer. The attestation grants
 * nothing; the market keeps it in the chain, and devices check the chain's first key with it.
 */

const AttestationRequest = z.strictObject({ upload_sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export function orgRegistryRoutes(deps: {
  access: OrgAccess;
  signingKey: GrantSigningKey;
  now: () => number;
}) {
  return {
    /** POST /v1/orgs/{org}/registry/attestations — an owner's (`registry:key`) only. */
    attest: (request: Request, org: string) =>
      deps.access.member(request, org, "registry:key", async (member) => {
        const body = AttestationRequest.safeParse(await jsonBody(request, 1024));
        if (!body.success) return fail(400, "invalid_request");
        const attestation = signRegistryKeyAttestation(
          {
            org: member.org,
            upload_sha256: body.data.upload_sha256,
            account: member.principal.account.id,
            role: member.role,
            at: deps.now(),
          },
          deps.signingKey,
        );
        return json(201, { attestation });
      }),
  };
}
