import {
  appealId,
  draftId,
  entryKey,
  get,
  handle,
  hash,
  post,
  put,
  reportId,
  transferId,
  versionKey,
  type Methods,
} from "./route-keys.ts";

/*
 * The publisher's paths under `/v1/me/…` (ADR 0173 §4, §5, §13) and the signer's under
 * `/v1/signer/…` (ADR 0168 §6, ADR 0173 §9, §10). Each takes the path's segments after its
 * prefix.
 */

/** `/v1/me/entries/{type}/{name}/…`. */
function entryPaths(rest: readonly string[]): Methods | undefined {
  const [t, n, what, v, action, ...more] = rest;
  if (more.length > 0) return undefined;
  const entry = entryKey(t, n);
  if (!entry) return undefined;
  if (what === undefined)
    return { GET: { kind: "me-entry", ...entry }, DELETE: { kind: "me-entry-delete", ...entry } };
  if (rest.length === 3)
    switch (what) {
      case "listing":
        return put({ kind: "me-listing", ...entry });
      case "latest":
        return put({ kind: "me-latest", ...entry });
      case "visibility":
        return put({ kind: "me-visibility", ...entry });
      case "archived":
        return put({ kind: "me-archived", ...entry });
      case "withdraw":
        return post({ kind: "me-entry-withdraw", ...entry });
      case "transfer":
        return post({ kind: "me-transfer", ...entry });
      case "signals":
        return get({ kind: "me-signals", ...entry });
      default:
        return undefined;
    }
  if (rest.length === 4 && what === "previews" && v !== undefined && /^[0-3]$/.test(v))
    return put({ kind: "me-preview", ...entry, index: Number(v) });
  const key = rest.length === 5 && what === "versions" ? versionKey(t, n, v) : undefined;
  if (!key) return undefined;
  switch (action) {
    case "changelog":
      return put({ kind: "me-changelog", ...key });
    case "deprecation":
      return { PUT: { kind: "me-deprecate", ...key }, DELETE: { kind: "me-undeprecate", ...key } };
    case "withdraw":
      return post({ kind: "me-version-withdraw", ...key });
    case "appeal":
      return post({ kind: "me-appeal", ...key });
    default:
      return undefined;
  }
}

/** `/v1/me/…`, every route of it needing a market grant. */
export function meRoutes(rest: readonly string[]): Methods | undefined {
  const [first, a, b, ...more] = rest;
  if (first === undefined) return get({ kind: "me" });
  switch (first) {
    case "profile":
      return rest.length === 1
        ? { POST: { kind: "me-profile-create" }, PUT: { kind: "me-profile-edit" } }
        : undefined;
    case "handle":
      return rest.length === 1 ? put({ kind: "me-handle" }) : undefined;
    case "avatar":
      return rest.length === 1 ? put({ kind: "me-avatar" }) : undefined;
    case "pins":
      return rest.length === 1 ? put({ kind: "me-pins" }) : undefined;
    case "verification":
      if (rest.length === 1)
        return { GET: { kind: "me-verification" }, POST: { kind: "me-verification-apply" } };
      return rest.length === 2 && a === "check"
        ? post({ kind: "me-verification-check" })
        : undefined;
    case "drafts": {
      if (rest.length === 1) return post({ kind: "me-draft-create" });
      const id = draftId(a);
      if (!id || more.length > 0) return undefined;
      if (rest.length === 2)
        return {
          GET: { kind: "me-draft-read", id },
          PUT: { kind: "me-draft-replace", id },
          PATCH: { kind: "me-draft-patch", id },
          DELETE: { kind: "me-draft-delete", id },
        };
      return b === "publish" ? post({ kind: "me-draft-publish", id }) : undefined;
    }
    case "entries":
      return entryPaths(rest.slice(1));
    case "transfers": {
      const id = transferId(a);
      if (!id || rest.length !== 3) return undefined;
      if (b === "accept") return post({ kind: "me-transfer-accept", id });
      if (b === "decline") return post({ kind: "me-transfer-decline", id });
      return undefined;
    }
    default:
      return undefined;
  }
}

/** `/v1/signer/…`, behind the signer's token. */
export function signerRoutes(rest: readonly string[]): Methods | undefined {
  const [first, a, b, c, ...more] = rest;
  if (more.length > 0) return undefined;
  if (rest.length === 1)
    switch (first) {
      case "pending":
        return get({ kind: "signer-pending" });
      case "withdrawn":
        return put({ kind: "signer-withdrawn" });
      case "categories":
        return put({ kind: "signer-categories" });
      case "featured":
        return put({ kind: "signer-featured" });
      case "queue":
        return get({ kind: "signer-queue" });
      case "scan-context":
        return get({ kind: "signer-scan-context" });
      case "collections":
        return put({ kind: "signer-collections" });
      case "blocklist":
        return put({ kind: "signer-blocklist" });
      case "verified":
        return put({ kind: "signer-verified" });
      case "official":
        return put({ kind: "signer-official" });
      case "reports":
        return get({ kind: "signer-reports" });
      default:
        return undefined;
    }
  if (rest.length === 2) {
    switch (first) {
      case "objects": {
        const h = hash(a);
        return h ? get({ kind: "signer-object", hash: h }) : undefined;
      }
      case "publishers": {
        const h = handle(a);
        return h
          ? {
              GET: { kind: "signer-publisher-read", handle: h },
              PUT: { kind: "signer-publisher", handle: h },
            }
          : undefined;
      }
      case "reports": {
        const id = reportId(a);
        return id ? put({ kind: "signer-report", id }) : undefined;
      }
      case "appeals": {
        const id = appealId(a);
        return id ? put({ kind: "signer-appeal", id }) : undefined;
      }
      default:
        return undefined;
    }
  }
  if (rest.length === 3 && first === "listings") {
    const entry = entryKey(a, b);
    return entry ? put({ kind: "signer-listing", ...entry }) : undefined;
  }
  if (rest.length !== 4) return undefined;
  const key = versionKey(a, b, c);
  if (!key) return undefined;
  switch (first) {
    case "versions":
      return put({ kind: "signer-version", ...key });
    case "reviews":
      return put({ kind: "signer-review", ...key });
    case "holds":
      return put({ kind: "signer-hold", ...key });
    case "blocks":
      return put({ kind: "signer-block", ...key });
    default:
      return undefined;
  }
}
