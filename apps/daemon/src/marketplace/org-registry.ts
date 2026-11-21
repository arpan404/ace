import {
  GrantError,
  MARKET_GRANT_ISSUER,
  verifyMarketGrant,
  type GrantKeySet,
} from "@ace/account-grant";
import { SignatureError } from "@ace/marketplace";
import {
  RegistryChainError,
  chainStanding,
  verifyRegistryChain,
  verifyRegistryManifest,
  type RegistryPin,
  type VerifiedChain,
} from "@ace/marketplace/registry";
import { RegistryEntries, RegistryKeyChain } from "@ace/protocol/marketplace";
import type { MemberReads } from "./http.ts";
import { newer, Refused } from "./prepare.ts";
import type { MarketStore, StoredInstall } from "./store.ts";

/*
 * An organization's private registry on this device (ADR 0206 §5.3, §5.4). Installing or updating
 * from it needs a fresh proof, at the time, that this machine's account is a member: a market
 * grant acting in the organization, which the client got with the person's own session and the
 * account backend minted only after WorkOS answered. The registry's key chain is pinned on the
 * person's first trust; a chain that resets its first key is asked about again, and one that
 * rewrites or drops a pinned key is refused. A member who leaves keeps what they installed, its
 * updates stopped.
 */

/**
 * Who this machine answers to, a person's own machine or an organization's host, and its host
 * id: a member's grant names the machine it was asked for (`subject`), and is good there only.
 */
export type RegistryMachine =
  | { kind: "personal"; account: string | undefined; hostId: string | undefined }
  | { kind: "org-host"; org: string; hostId: string | undefined };

/** What checking a member's grant needs: the backend's pinned keys and who this machine is. */
export interface Membership {
  keys: GrantKeySet;
  machine: RegistryMachine;
  /** The `iss` the account backend names; `cloud.acehq.dev` unless configured. */
  issuer?: string | undefined;
}

/** A registry read for one request: the organization, a member's grant, and the person's trust. */
export interface RegistryRequest {
  org: string;
  grant: string;
  /** The first key the person trusts, answering `registry_trust`. */
  trustKey?: string | undefined;
}

const notMember = (message: string) => new Refused(message, { code: "not_member" });

/**
 * Why `grant` doesn't prove this machine's account is a member of `org` now, or undefined when
 * it does. On an organization's host, a member of that organization; on a person's machine, the
 * account signed in here.
 */
export function membershipProblem(
  grant: string | undefined,
  org: string,
  membership: Membership | undefined,
  now: number,
): string | undefined {
  if (!membership) return "This machine isn't signed in to ace, so it can't check membership.";
  if (!grant)
    return `Installing from ${org}'s registry needs a fresh check that you're a member: open it from an ace app signed in to the organization.`;
  let claims;
  try {
    claims = verifyMarketGrant(
      grant,
      membership.keys,
      now,
      membership.issuer ?? MARKET_GRANT_ISSUER,
    );
  } catch (error) {
    if (error instanceof GrantError)
      return "That membership check expired or isn't ace's. Try again.";
    throw error;
  }
  if (claims.org !== org) return "That membership check is for another organization.";
  const machine = membership.machine;
  // Asked for another machine, even another of the organization's hosts, it proves nothing here.
  if (machine.hostId === undefined || claims.subject !== machine.hostId)
    return "That membership check was made for another machine.";
  // One naming a single market request is that request's alone.
  if (claims.action !== undefined) return "That membership check was made for another request.";
  if (machine.kind === "org-host")
    return machine.org === org ? undefined : "This machine is another organization's host.";
  return machine.account === claims.account
    ? undefined
    : "The account signed in on this machine isn't the member that check is for.";
}

/** The refusal when `grant` doesn't prove membership now. */
export function requireMember(
  grant: string | undefined,
  org: string,
  membership: Membership | undefined,
  now: number,
): void {
  const problem = membershipProblem(grant, org, membership, now);
  if (problem) throw notMember(problem);
}

const pinKey = (org: string) => `registry-pin:${org}`;

function pinOf(store: MarketStore, org: string): RegistryPin | undefined {
  const text = store.meta(pinKey(org));
  if (!text) return undefined;
  // Rows this daemon wrote (ADR 0125): a pin is always `{ uploads: string[] }`.
  return JSON.parse(text) as RegistryPin;
}

/**
 * The registry's key chain as the market serves it, checked against what this device pinned.
 * New or reset, it is trusted only with the person's `trustKey` naming its first key (and then
 * pinned); trusted, a longer chain moves the pin forward; broken, it is refused.
 */
export async function trustedChain(
  reads: MemberReads,
  store: MarketStore,
  request: RegistryRequest,
  membership: Membership,
): Promise<VerifiedChain> {
  const served = RegistryKeyChain.safeParse(await reads.chain());
  if (!served.success || served.data.org !== request.org)
    throw new Refused("The registry's key chain isn't in a form this build reads");
  const pin = pinOf(store, request.org);
  let chain: VerifiedChain;
  try {
    chain = verifyRegistryChain(served.data, {
      grantKeys: membership.keys,
      ...(pin?.uploads[0] ? { trustedFirst: pin.uploads[0] } : {}),
    });
  } catch (error) {
    if (error instanceof RegistryChainError)
      throw new Refused(
        `${request.org}'s registry key chain is broken: ${error.message}. Nothing was installed.`,
      );
    throw error;
  }
  const standing = chainStanding(chain, pin);
  if (standing === "broken")
    throw new Refused(
      `${request.org}'s registry key chain doesn't follow the one this machine trusts. Nothing was installed.`,
    );
  const first = chain.statements[0];
  if (!first) throw new Refused("The registry has no key");
  if ((standing === "new" || standing === "reset") && request.trustKey !== first.key)
    throw new Refused(
      standing === "reset"
        ? `${request.org}'s registry key was reset by ${first.addedBy}. Trust the new key ${first.key} for installs on this machine?`
        : `${request.org}'s registry, key ${first.key}, added by ${first.addedBy}. Trust it for installs on this machine?`,
      {
        code: "registry_trust",
        registryKey: {
          org: request.org,
          key: first.key,
          addedBy: first.addedBy,
          at: first.at,
          reset: standing === "reset",
        },
      },
    );
  if (standing !== "trusted" || chain.uploads.length > (pin?.uploads.length ?? 0))
    store.setMeta(pinKey(request.org), JSON.stringify({ uploads: chain.uploads }));
  return chain;
}

/** What an open review from a registry installs: checked again at the moment it installs. */
export interface RegistryReview {
  org: string;
  type: string;
  name: string;
  version: string;
  hash: string;
  signedManifest: unknown;
}

/**
 * Inside the install queue, right before anything lands: the account is still a member (with the
 * grant sent with the install), the registry's chain as the market serves it now still extends
 * what this device trusts, and the reviewed version's signed manifest verifies against that
 * chain for these very bytes. A chain reset or rotated since the review, or a key it no longer
 * holds, refuses the install.
 */
export async function confirmRegistryInstall(
  reads: MemberReads,
  store: MarketStore,
  review: RegistryReview,
  request: RegistryRequest,
  membership: Membership,
): Promise<void> {
  const chain = await trustedChain(reads, store, request, membership);
  let manifest;
  try {
    manifest = verifyRegistryManifest(review.signedManifest, chain);
  } catch (error) {
    if (error instanceof SignatureError)
      throw new Refused(
        `What you reviewed is no longer signed by ${review.org}'s registry: ${error.message}. Nothing was installed.`,
      );
    throw error;
  }
  if (
    manifest.type !== review.type ||
    manifest.name !== review.name ||
    manifest.version !== review.version ||
    manifest.hash !== review.hash
  )
    throw new Refused("The registry's signature is for another version. Nothing was installed.");
}

const stopped = (org: string) =>
  `From ${org}'s registry · updates stopped: you're no longer a member`;

/** Every install from `org`'s registry: it stays as it is, its updates stopped. */
export function stopUpdates(store: MarketStore, org: string): boolean {
  let changed = false;
  for (const install of store.installs()) {
    if (install.registry !== org || install.updatesStopped) continue;
    const { update: _update, ...rest } = install;
    store.saveInstall({ ...rest, updatesStopped: stopped(org) });
    changed = true;
  }
  return changed;
}

/**
 * Marks which installs from `org`'s registry have newer versions, from its entry list read with a
 * member's grant, and resumes updates stopped before. True when an install changed.
 */
export async function refreshRegistry(
  reads: MemberReads,
  store: MarketStore,
  org: string,
): Promise<boolean> {
  const listed = RegistryEntries.safeParse(await reads.entries());
  if (!listed.success) throw new Refused("The registry's list isn't in a form this build reads");
  const latest = new Map(
    listed.data.entries.map((entry) => [`${entry.type}/${entry.name}`, entry.latest]),
  );
  let changed = false;
  for (const install of store.installs()) {
    if (install.registry !== org) continue;
    const offered = latest.get(`${install.type}/${install.name}`);
    const update = offered && newer(offered, install.version) ? offered : undefined;
    if (update === install.update && install.updatesStopped === undefined) continue;
    const { update: _update, updatesStopped: _stopped, ...rest } = install;
    const next: StoredInstall = { ...rest, ...(update ? { update } : {}) };
    store.saveInstall(next);
    changed = true;
  }
  return changed;
}
