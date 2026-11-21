import { orgAllows } from "@ace/account-grant/org-roles";
import { skeleton } from "@ace/marketplace/profile";
import {
  RegistryChainError,
  readRegistryKeyUpload,
  verifyRegistryChain,
} from "@ace/marketplace/registry";
import { RegistryCreate, RegistryKeyLink, type RegistryKeyChain } from "@ace/protocol/marketplace";
import { handleRefusal } from "./api-publish.ts";
import { authenticate, type Authed } from "./auth.ts";
import type { Context } from "./context.ts";
import { failure, json, notFound, readCapped, refused } from "./http.ts";
import { mayRead, privateHeaders } from "./registry-access.ts";
import type { Route } from "./routes.ts";
import { claimPublisher } from "./store/publish.ts";
import {
  addKey,
  chainState,
  orgAudience,
  recordRegistry,
  registryEntries,
  registryKeys,
  registryOf,
  type Registry,
} from "./store/registries.ts";

/*
 * An organization's registry, as its owners and members reach it (ADR 0206 §5.1, §5.3). Owners
 * open it under a handle and publish its key chain from their own session; members read the
 * chain and the entries. Anyone else is answered 404, as for a registry that doesn't exist.
 */

const ownersOnly = () =>
  failure(403, "forbidden", "Only an owner of the organization may do this (registry:key).");

/** An owner's grant acting in `org`, from the person's own session for this very request. */
async function owner(request: Request, context: Context, org: string): Promise<Authed | Response> {
  const authed = await authenticate(request, context, { org: "claims", sensitive: true });
  if (authed instanceof Response) return authed;
  if (authed.org !== org) return notFound();
  if (!orgAllows(authed.claims.orgRole ?? "", "registry:key")) return ownersOnly();
  return authed;
}

export async function orgRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  switch (route.kind) {
    case "org-registry":
      return create(request, route.org, context);
    case "org-keys":
      return (await mayRead(request, context, orgAudience(route.org)))
        ? chainAnswer(context, route.org)
        : notFound();
    case "org-key-add":
      return addRegistryKey(request, route.org, context);
    case "org-entries": {
      const registry = await membersRegistry(request, route.org, context);
      if (!registry) return notFound();
      const entries = await registryEntries(context.dbs, route.org);
      return json({ org: route.org, publisher: registry.publisher, entries }, 200, privateHeaders);
    }
    default:
      return undefined;
  }
}

/** The registry's key chain, once the caller is known to be its member or signer. */
export async function chainAnswer(context: Context, org: string): Promise<Response> {
  const registry = await registryOf(context.dbs, org);
  if (!registry || !context.dbs.orgs) return notFound();
  const keys = await registryKeys(context.dbs.orgs, org);
  if (keys.length === 0) return notFound();
  const chain: RegistryKeyChain = {
    org,
    publisher: registry.publisher,
    keys: keys.map((key) => key.link),
  };
  return json(chain, 200, privateHeaders);
}

/** The organization's registry, when this request is a member's. */
async function membersRegistry(
  request: Request,
  org: string,
  context: Context,
): Promise<Registry | undefined> {
  if (!(await mayRead(request, context, orgAudience(org)))) return undefined;
  return registryOf(context.dbs, org);
}

async function create(request: Request, org: string, context: Context): Promise<Response> {
  const authed = await owner(request, context, org);
  if (authed instanceof Response) return authed;
  const orgs = context.dbs.orgs;
  if (!orgs) return notFound();
  const bytes = await readCapped(request, 4096);
  let parsed;
  try {
    parsed = RegistryCreate.safeParse(JSON.parse(new TextDecoder().decode(bytes ?? undefined)));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) return refused([{ message: "Name the registry's handle." }]);
  const { handle } = parsed.data;
  const existing = await registryOf(context.dbs, org);
  if (existing) return failure(409, "conflict", "This organization has a registry already.");
  const publishers = context.dbs.publishers;
  // The organization's publisher is the row whose account is the organization; a request that
  // stopped after making it finds it again.
  const claim = await claimPublisher(publishers, {
    id: context.newId("pub"),
    account: org,
    name: handle,
    skeleton: skeleton(handle),
    now: context.now,
  }).catch((error: unknown) => {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) return { taken: "name" as const };
    throw error;
  });
  if ("taken" in claim && claim.taken === "name") {
    const refusal = await handleRefusal(publishers, handle);
    return refusal ?? failure(409, "conflict", "That publisher name is taken.");
  }
  const publisher = "claimed" in claim ? claim.claimed : claim.publisher;
  await recordRegistry(orgs, {
    org,
    publisher: publisher.id,
    account: authed.account,
    now: context.now,
  });
  const registry = await registryOf(context.dbs, org);
  return registry ? json(registry, 201) : failure(409, "conflict", "Try again.");
}

async function addRegistryKey(request: Request, org: string, context: Context): Promise<Response> {
  const authed = await owner(request, context, org);
  if (authed instanceof Response) return authed;
  const orgs = context.dbs.orgs;
  const registry = await registryOf(context.dbs, org);
  if (!orgs || !registry) return notFound();
  const bytes = await readCapped(request, 16 * 1024);
  let sent;
  try {
    sent = RegistryKeyLink.safeParse(JSON.parse(new TextDecoder().decode(bytes ?? undefined)));
  } catch {
    sent = undefined;
  }
  if (!sent?.success)
    return refused([{ message: "Send the key's upload with the account service's attestation." }]);
  const link = sent.data;
  const keys = await context.grantKeys.get();
  if (!keys) return failure(503, "unavailable", "The market can't check sign-ins right now.");
  let statement;
  let verified;
  let state;
  try {
    statement = readRegistryKeyUpload(link.upload).statement;
    if (statement.org !== org || statement.addedBy !== authed.account)
      return refused([{ message: "The key names another organization or owner." }]);
    // The new link with the chain it extends, checked as a device will check it: the backend's
    // attestation vouches for a first key, the key before signs a later one.
    state = await chainState(orgs, org);
    const before = statement.position === 0 ? [] : state.keys.map((key) => key.link);
    verified = verifyRegistryChain(
      { org, publisher: registry.publisher, keys: [...before, link] },
      {
        grantKeys: keys,
        // Its first key was checked when it was stored; a rotation is checked against it.
        ...(before[0] ? { trustedFirst: before[0].upload } : {}),
      },
    );
  } catch (error) {
    if (error instanceof RegistryChainError) return refused([{ message: error.message }]);
    throw error;
  }
  const added = await addKey(orgs, {
    org,
    position: statement.position,
    keyId: statement.key,
    publicKey: statement.publicKey,
    upload: link.upload,
    attestation: link.attestation,
    addedBy: authed.account,
    at: statement.at,
    // Only onto the chain this request verified, after the very key it verified it follows.
    revision: state.revision,
    previousUpload:
      statement.position === 0 ? undefined : state.keys[statement.position - 1]?.link.upload,
    writer: context.newToken(),
  });
  if (!added) return failure(409, "conflict", "The registry's key chain changed; read it again.");
  return json(
    { status: "stored", org, key: verified.current.id, position: statement.position },
    201,
  );
}
