import { SignatureError } from "@ace/marketplace";
import { verifyRegistryManifest } from "@ace/marketplace/registry";
import { BlockDecision, HoldDecision, SignedVersionUpload } from "@ace/protocol/marketplace";
import { usageChanged } from "./api-maintainers.ts";
import { malformed, signatureRefused } from "./api-signer.ts";
import { objectKey, versionReportKey, type Context } from "./context.ts";
import { failure, json, notFound, readCapped, refused } from "./http.ts";
import { registrySigner } from "./registry-access.ts";
import type { Route, VersionKey } from "./routes.ts";
import { fromCatalogues } from "./store/databases.ts";
import { signedList, listDb } from "./store/lists.ts";
import { blockVersion, decideHold, scanContext, type Decided } from "./store/maintainers.ts";
import { orgAudience, registryKeys } from "./store/registries.ts";
import { listVersion, pendingVersions, versionForSigning } from "./store/signer.ts";

/*
 * An organization's signer (ADR 0206 §5.2), on the org's own machine with the registry key: it
 * pulls the registry's versions that passed the scan, checks them again and signs them with
 * `registry: <org>`. Every request is proved by the registry's current key, which is its only
 * credential; the market holds no secret for it. It sees only its own organization's versions
 * and bytes. It may hold a version for ace's maintainers or block it, never release a hold:
 * the scan's holds are ace's, unchanged (ADR 0174 §8).
 */

const notSigner = () =>
  failure(401, "unauthorized", "Only the registry's signer, with its current key, may do that.");

const decided = (result: Decided, conflict: string) =>
  result === "done"
    ? json({ status: "done" })
    : result === "missing"
      ? notFound()
      : failure(409, "conflict", conflict);

export async function orgSignerRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  if (!route.kind.startsWith("org-signer-") || !("org" in route)) return undefined;
  const org = route.org;
  const body = request.method === "GET" ? new Uint8Array() : await readCapped(request, 1024 * 1024);
  if (!body) return failure(413, "too_large", "That upload is too large.");
  if (!(await registrySigner(request, context, org, body))) return notSigner();
  const dbs = context.dbs;
  const audience = orgAudience(org);
  const parsed = () => {
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      return undefined;
    }
  };
  switch (route.kind) {
    case "org-signer-pending": {
      // ace's signed lists ride along: the signer's scan reads the blocklist and the official
      // publisher as the market's own signer does.
      const [versions, blocklist, official] = await Promise.all([
        pendingVersions(dbs, audience),
        signedList(listDb(dbs, "blocklist"), "blocklist"),
        signedList(listDb(dbs, "official"), "official"),
      ]);
      return json({
        versions,
        withdrawals: [],
        ...(blocklist ? { blocklist: blocklist.signed } : {}),
        ...(official ? { official: official.signed } : {}),
      });
    }
    case "org-signer-scan-context":
      return json(await scanContext(dbs, context.now));
    case "org-signer-object": {
      if (!(await registryHolds(context, audience, route.hash))) return notFound();
      const stored = await context.env.OBJECTS.get(objectKey(route.hash));
      return stored
        ? new Response(stored.body, { headers: { "content-type": "application/x-tar" } })
        : notFound();
    }
    case "org-signer-version":
      return sign(org, route, SignedVersionUpload.safeParse(parsed()), context);
    case "org-signer-hold": {
      const decision = HoldDecision.safeParse(parsed());
      if (!decision.success) return malformed();
      if (decision.data.decision !== "hold")
        return failure(403, "forbidden", "Only ace's maintainers release a hold.");
      const db = await registryCatalogue(context, audience, route);
      if (!db) return notFound();
      const result = await decideHold(db, route, "hold", context.now);
      if (result === "done") {
        await usageChanged(context, db, route);
        if (decision.data.scan)
          await context.env.OBJECTS.put(
            versionReportKey(route),
            JSON.stringify(decision.data.scan),
          );
      }
      return decided(result, "That version is listed or blocked; it can't be held.");
    }
    case "org-signer-block": {
      const decision = BlockDecision.safeParse(parsed());
      if (!decision.success) return malformed();
      const db = await registryCatalogue(context, audience, route);
      if (!db) return notFound();
      const result = await blockVersion(db, route, decision.data.reason, context.now);
      if (result === "done") {
        await usageChanged(context, db, route);
        if (decision.data.scan)
          await context.env.OBJECTS.put(
            versionReportKey(route),
            JSON.stringify(decision.data.scan),
          );
      }
      return decided(result, "That version is listed already.");
    }
    default:
      return undefined;
  }
}

/** The version's catalogue, when the version is this registry's. */
async function registryCatalogue(context: Context, audience: string, key: VersionKey) {
  const db = context.dbs.catalogue(key.type);
  const stored = db ? await versionForSigning(db, key) : undefined;
  return stored?.audience === audience ? db : undefined;
}

/** Whether any of this registry's versions, in any state, holds these bytes. */
async function registryHolds(context: Context, audience: string, hash: string) {
  const found = await fromCatalogues(context.dbs, async ({ db }) => {
    const row = await db
      .prepare(
        `SELECT 1 AS found FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
          WHERE v.hash = ?1 AND e.audience = ?2 LIMIT 1`,
      )
      .bind(hash, audience)
      .first();
    return row ? [row] : [];
  });
  return found.length > 0;
}

async function sign(
  org: string,
  key: VersionKey,
  upload: ReturnType<typeof SignedVersionUpload.safeParse>,
  context: Context,
): Promise<Response> {
  if (!upload.success || !context.dbs.orgs) return malformed();
  const keys = await registryKeys(context.dbs.orgs, org);
  const current = keys.at(-1);
  if (!current) return notFound();
  let manifest;
  try {
    // Signed with the key that signs now, for this registry: the chain was checked as stored.
    const chainKeys = keys.map((stored) => ({ id: stored.keyId, publicKey: stored.publicKey }));
    manifest = verifyRegistryManifest(upload.data.manifest, { org, keys: chainKeys });
    if (manifest.key !== current.keyId)
      throw new SignatureError("Signed with an earlier key; sign with the registry's current key");
  } catch (error) {
    return signatureRefused(error);
  }
  const db = await registryCatalogue(context, orgAudience(org), key);
  const stored = db ? await versionForSigning(db, key) : undefined;
  if (!db || !stored) return notFound();
  if (stored.state !== "pending" && stored.state !== "listed")
    return failure(409, "conflict", `That version is ${stored.state}; a maintainer decides it.`);
  const matches =
    manifest.type === key.type &&
    manifest.name === key.name &&
    manifest.version === key.version &&
    manifest.publisher.id === stored.publisher.id &&
    manifest.publisher.name === stored.publisher.name &&
    manifest.hash === stored.hash &&
    manifest.size === stored.size;
  if (!matches)
    return refused([{ message: "The manifest names another version, publisher or files" }]);
  const listed = await listVersion(
    db,
    key,
    {
      manifest: JSON.stringify(upload.data.manifest),
      hash: stored.hash,
      size: stored.size,
      publisher: stored.publisher.id,
    },
    context.now,
  );
  if (!listed)
    return failure(409, "conflict", "That version was held, blocked or submitted again.");
  return json({ status: "listed", ...key, hash: stored.hash });
}
