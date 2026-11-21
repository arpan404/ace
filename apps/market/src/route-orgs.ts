import { entryKey, get, hash, orgId, post, put, versionKey, type Methods } from "./route-keys.ts";

/*
 * An organization's registry paths, `/v1/orgs/{org}/…` (ADR 0206 §5): its creation and key chain
 * (owners), its entries (members), and its signer's (`/v1/orgs/{org}/signer/…`, proved by the
 * registry key). Takes the segments after `orgs`.
 */
export function orgRoutes(rest: readonly string[]): Methods | undefined {
  const [id, first, a, b, c, d, ...more] = rest;
  const org = orgId(id);
  if (!org || more.length > 0) return undefined;
  if (rest.length === 2)
    switch (first) {
      case "registry":
        return post({ kind: "org-registry", org });
      case "keys":
        return { GET: { kind: "org-keys", org }, POST: { kind: "org-key-add", org } };
      case "entries":
        return get({ kind: "org-entries", org });
      default:
        return undefined;
    }
  // A member's reads of the registry: under the organization, so nothing on the public market's
  // paths ever reaches a registry's row, and membership is decided before anything is read.
  if (first === "entries") {
    if (rest.length === 4) {
      const entry = entryKey(a, b);
      return entry ? get({ kind: "org-entry", org, ...entry }) : undefined;
    }
    const key = rest.length === 5 ? versionKey(a, b, c) : undefined;
    return key ? get({ kind: "org-version", org, ...key }) : undefined;
  }
  if (first === "objects") {
    const h = rest.length === 3 ? hash(a) : undefined;
    return h ? get({ kind: "org-object", org, hash: h }) : undefined;
  }
  if (first !== "signer") return undefined;
  if (rest.length === 3) {
    if (a === "pending") return get({ kind: "org-signer-pending", org });
    if (a === "scan-context") return get({ kind: "org-signer-scan-context", org });
    if (a === "keys") return get({ kind: "org-signer-keys", org });
    return undefined;
  }
  if (rest.length === 4 && a === "objects") {
    const h = hash(b);
    return h ? get({ kind: "org-signer-object", org, hash: h }) : undefined;
  }
  // What the signer's checks read back (an earlier version, to compare its contracts).
  if (rest.length === 5 && a === "entries") {
    const entry = entryKey(b, c);
    return entry ? get({ kind: "org-signer-entry", org, ...entry }) : undefined;
  }
  const key = rest.length === 6 ? versionKey(b, c, d) : undefined;
  if (!key) return undefined;
  switch (a) {
    case "entries":
      return get({ kind: "org-signer-entry-version", org, ...key });
    case "versions":
      return put({ kind: "org-signer-version", org, ...key });
    case "holds":
      return put({ kind: "org-signer-hold", org, ...key });
    case "blocks":
      return put({ kind: "org-signer-block", org, ...key });
    default:
      return undefined;
  }
}
