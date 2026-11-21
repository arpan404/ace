import { object, tagged } from "./api-read.ts";
import { entryPage } from "./catalog.ts";
import type { Context } from "./context.ts";
import { notFound } from "./http.ts";
import { grantOrg } from "./registry-access.ts";
import type { Route } from "./routes.ts";
import { signedVersion } from "./store/read.ts";
import { orgAudience, storedName } from "./store/registries.ts";

/*
 * A member's reads of an organization's registry (ADR 0206 §5.1): an entry, a version and an
 * archive, under `/v1/orgs/{org}/…`. Who may read is decided first, from the request alone (a
 * market grant acting in the organization; the signer has its own routes), and only then is anything
 * looked up, and only in that registry: a caller who isn't a member costs no lookup, and gets
 * the same 404 as for an entry that doesn't exist.
 */

export async function orgReadRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  if (route.kind !== "org-entry" && route.kind !== "org-version" && route.kind !== "org-object")
    return undefined;
  // A member's grant, checked before anything is read; the signer reads under its own routes.
  if ((await grantOrg(request, context)) !== route.org) return notFound();
  if (route.kind === "org-object")
    return object(request, route.hash, orgAudience(route.org), context);
  return route.kind === "org-version"
    ? registryVersion(request, context, route.org, route)
    : registryEntry(request, context, route.org, route);
}

/** A registry's signed version, once the caller is known to be its member or signer. */
export async function registryVersion(
  request: Request,
  context: Context,
  org: string,
  key: { type: string; name: string; version: string },
): Promise<Response> {
  const db = context.dbs.catalogue(key.type);
  const signed = db
    ? await signedVersion(db, { ...key, name: storedName(key.name, org) })
    : undefined;
  return signed ? tagged(request, signed, true) : notFound();
}

/** A registry's entry page, once the caller is known to be its member or signer. */
export async function registryEntry(
  request: Request,
  context: Context,
  org: string,
  key: { type: string; name: string },
): Promise<Response> {
  // Stored under `<name>@<org>`: only this registry's row can answer.
  const page = await entryPage(context.dbs, key.type, storedName(key.name, org));
  if (!page) return notFound();
  const { row: _row, ...body } = page;
  // Shown under its own name; it is unlisted by being the organization's, not by choice.
  return tagged(
    request,
    { ...body, entry: { ...body.entry, name: key.name }, unlisted: false },
    true,
  );
}
