import type { AceOrgClient } from "@ace/client/ace-org";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  orgKey,
  useAceAccount,
  useAceAccountStore,
  useSpace,
} from "@/features/ace-account/index.ts";

/*
 * An organization's reads and changes on the account backend (ADR 0206 §2.7), with the window's
 * session. Every read is keyed by the account and the organization, so one organization's rows
 * are never drawn in another, nor for another account in the same window. A refusal goes to the
 * space (`failed`): an ended session, a membership WorkOS no longer counts, a sign-in policy.
 */

type Calls = { orgs: AceOrgClient; token: string };
const within = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);

/** The read's key: the organization's, under the window's backend and account. */
export function useOrgReadKey(org: string | undefined, name: string) {
  const store = useAceAccountStore();
  const account = useAceAccount().session?.account.id;
  return [...orgKey, store?.origin, account, org, name] as const;
}

function useOrgRead<T>(
  org: string | undefined,
  name: string,
  read: (calls: Calls, org: string, signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  const { calls, failed } = useSpace();
  const key = useOrgReadKey(org, name);
  return useQuery({
    queryKey: key,
    enabled: Boolean(calls && org) && enabled,
    staleTime: 15_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!calls || !org) throw new Error("Sign in to your ace account first.");
      try {
        return await read(calls, org, within(signal));
      } catch (error) {
        failed(error);
        throw error;
      }
    },
  });
}

/** A change to `org`; the reads it names are read again once it lands. */
function useOrgChange<A, R>(
  org: string | undefined,
  run: (calls: Calls, org: string, input: A, signal: AbortSignal) => Promise<R>,
  reread: readonly string[],
) {
  const { calls, failed } = useSpace();
  const queryClient = useQueryClient();
  const base = useOrgReadKey(org, "");
  return useMutation({
    mutationFn: async (input: A) => {
      if (!calls || !org) throw new Error("Sign in to your ace account first.");
      try {
        return await run(calls, org, input, within());
      } catch (error) {
        failed(error);
        throw error;
      }
    },
    onSuccess: async () => {
      await Promise.all(
        reread.map((name) =>
          queryClient.invalidateQueries({ queryKey: [...base.slice(0, -1), name] }),
        ),
      );
    },
  });
}

export const useOrgMembers = (org: string | undefined) =>
  useOrgRead(org, "members", (c, id, s) => c.orgs.members(c.token, id, s));

export const useOrgInvitations = (org: string | undefined, enabled: boolean) =>
  useOrgRead(org, "invitations", (c, id, s) => c.orgs.invitations(c.token, id, s), enabled);

export const useOrgPolicy = (org: string | undefined) =>
  useOrgRead(org, "policy", (c, id, s) => c.orgs.policy(c.token, id, s));

export const useOrgHostList = (org: string | undefined) =>
  useOrgRead(org, "hosts", (c, id, s) => c.orgs.hosts(c.token, id, s));

export const useInvite = (org: string | undefined) =>
  useOrgChange(
    org,
    (c, id, input: { email: string; role: "member" | "admin" | "owner" }, s) =>
      c.orgs.invite(c.token, id, input, s),
    ["invitations"],
  );

export const useRevokeInvitation = (org: string | undefined) =>
  useOrgChange(
    org,
    (c, id, invitation: string, s) => c.orgs.revokeInvitation(c.token, id, invitation, s),
    ["invitations"],
  );

export const useChangeRole = (org: string | undefined) =>
  useOrgChange(
    org,
    (c, id, input: { account: string; role: "member" | "admin" | "owner" }, s) =>
      c.orgs.changeRole(c.token, id, input.account, input.role, s),
    ["members"],
  );

/** Remove a member: deletes their membership and nothing else of theirs. */
export const useRemoveMember = (org: string | undefined) =>
  useOrgChange(org, (c, id, account: string, s) => c.orgs.removeMember(c.token, id, account, s), [
    "members",
  ]);

export const useSetPolicy = (org: string | undefined) =>
  useOrgChange(
    org,
    (c, id, policy: Parameters<AceOrgClient["setPolicy"]>[2], s) =>
      c.orgs.setPolicy(c.token, id, policy, s),
    ["policy"],
  );

export const useReleaseHost = (org: string | undefined) =>
  useOrgChange(org, (c, id, hostId: string, s) => c.orgs.releaseHost(c.token, id, hostId, s), [
    "hosts",
  ]);

/** An Admin Portal link, opened at once; it lasts five minutes. */
export const usePortalLink = (org: string | undefined) =>
  useOrgChange(
    org,
    (c, id, intent: Parameters<AceOrgClient["portal"]>[2], s) =>
      c.orgs.portal(c.token, id, intent, s),
    [],
  );
