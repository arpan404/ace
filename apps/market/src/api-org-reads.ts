import { object, tagged } from "./api-read.ts";
import { entryPage } from "./catalog.ts";
import type { Context } from "./context.ts";
import { notFound } from "./http.ts";
import { grantOrg, registrySigner } from "./registry-access.ts";
import type { Route } from "./routes.ts";
import { signedVersion } from "./store/read.ts";
import { orgAudience, storedName } from "./store/registries.ts";

/*
 * A member's reads of an organization's registry (ADR 0206 §5.1): an entry, a version and an
 * archive, under `/v1/orgs/{org}/…`. Who may read is decided first, from the request alone (a
 * market grant acting in the organization, or the registry's signer), and only then is anything
 * looked up, and only in that registry: a caller who isn't a member costs no lookup, and gets
 * the same 404 as for an entry that doesn't exist.
 */

/** Whether the request is a member's of `org`, or its signer's. */
async function member(request: Request, context: Context, org: string): Promise<boolean> {
  return (await grantOrg(request, context)) === org || registrySigner(request, context, org);
}

export async function orgReadRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  if (route.kind !== "org-entry" && route.kind !== "org-version" && route.kind !== "org-object")
    return undefined;
  if (!(await member(request, context, route.org))) return notFound();
  if (route.kind === "org-object")
    return object(request, route.hash, orgAudience(route.org), context);
  const name = storedName(route.name, route.org);
  if (route.kind === "org-version") {
    const db = context.dbs.catalogue(route.type);
    const signed = db ? await signedVersion(db, { ...route, name }) : undefined;
    return signed ? tagged(request, signed, true) : notFound();
  }
  // Stored under `<name>@<org>`: only this registry's row can answer.
  const page = await entryPage(context.dbs, route.type, name);
  if (!page) return notFound();
  const { row: _row, ...body } = page;
  // Shown under its own name; it is unlisted by being the organization's, not by choice.
  return tagged(
    request,
    { ...body, entry: { ...body.entry, name: route.name }, unlisted: false },
    true,
  );
}
