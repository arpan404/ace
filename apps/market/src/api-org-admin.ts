import { MarketWithdrawRequest, type RegistryAdmin } from "@ace/protocol/marketplace";
import { authenticate, mayPublishFor, type Authed } from "./auth.ts";
import type { Context } from "./context.ts";
import { failure, json, notFound, readJson } from "./http.ts";
import { privateHeaders } from "./registry-access.ts";
import type { Route } from "./routes.ts";
import { addWithdrawal, storedVersion } from "./store/publish.ts";
import { registryVersions } from "./store/registry-admin.ts";
import { registryOf, storedName, type Registry } from "./store/registries.ts";

/*
 * An organization's registry as those who may publish to it manage it (ADR 0206 amendment 5):
 * every version with its scan result, and withdrawing one, which queues it for the registry's
 * signer. A member without the role is refused (403); anyone outside the organization is
 * answered 404, as for a registry that doesn't exist.
 */

const notPublisher = () =>
  failure(
    403,
    "forbidden",
    "Managing this organization's registry needs the registry:publish role.",
  );

/** The caller, when it acts in `org` and may publish to its registry; else the refusal. */
async function registryAdmin(
  request: Request,
  context: Context,
  org: string,
  sensitive: boolean,
): Promise<{ authed: Authed; registry: Registry } | Response> {
  const authed = await authenticate(request, context, { org: "claims", sensitive });
  // A read refused at sign-in says nothing exists here: no sign-in, a member who has left, or a
  // standing the account backend can't confirm now (ADR 0206 §6: 404 reads, 503 writes). A write
  // says what it needs.
  if (authed instanceof Response) return sensitive ? authed : notFound();
  if (authed.org !== org) return notFound();
  const registry = await registryOf(context.dbs, org);
  if (!registry) return notFound();
  if (!(await mayPublishFor(context.dbs, authed.claims, org))) return notPublisher();
  return { authed, registry };
}

export async function orgAdminRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  switch (route.kind) {
    case "org-registry-admin": {
      const admitted = await registryAdmin(request, context, route.org, false);
      if (admitted instanceof Response) return admitted;
      const body: RegistryAdmin = {
        org: route.org,
        publisher: admitted.registry.publisher,
        entries: await registryVersions(context.dbs, route.org),
      };
      return json(body, 200, privateHeaders);
    }
    case "org-version-withdraw": {
      const admitted = await registryAdmin(request, context, route.org, true);
      if (admitted instanceof Response) return admitted;
      const db = context.dbs.catalogue(route.type);
      // Stored under `<name>@<org>`: only this registry's row can answer.
      const key = {
        type: route.type,
        name: storedName(route.name, route.org),
        version: route.version,
      };
      const stored = db ? await storedVersion(db, key) : undefined;
      if (!db || !stored || stored.state === "blocked") return notFound();
      const parsed = MarketWithdrawRequest.safeParse(await readJson(request, 16 * 1024));
      if (!parsed.success) return failure(400, "invalid", "Say why the version is withdrawn.");
      // Queued for the registry's signer; the public signer's feed reads public entries only.
      const added = await addWithdrawal(db, {
        ...key,
        publisher: admitted.registry.publisher.id,
        hash: stored.hash,
        reason: parsed.data.reason,
        at: context.now,
      });
      if (!added) return notFound();
      return json({ status: "pending", ...route, hash: stored.hash }, 202);
    }
    default:
      return undefined;
  }
}
