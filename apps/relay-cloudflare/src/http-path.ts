import { HostId } from "@ace/relay/wire";

/** Discovery documents clients also look for with the path inserted after the well-known name. */
const insertedMetadata = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
];

export type ForwardPath = {
  hostId: string;
  /** `/m/<hostId>`: the public base of this machine, after the relay's origin. */
  prefix: string;
  /** What the daemon sees: the path after the prefix, starting with `/`, and the query. */
  path: string;
};

/**
 * Which machine a public HTTP request is for (ADR 0122). Everything under `/m/<hostId>` goes to
 * that machine with the prefix removed. RFC 8414 and RFC 9728 put metadata for a resource with a
 * path at `/.well-known/<name>/m/<hostId>/…`; those reach the same machine as
 * `/.well-known/<name>/…`, the address it would serve at its own root. Anything else, or a
 * malformed host id, is not a forwarded path.
 */
export function forwardPath(url: URL): ForwardPath | undefined {
  let rest = url.pathname;
  let inserted = "";
  for (const name of insertedMetadata)
    if (rest.startsWith(`${name}/m/`)) {
      inserted = name;
      rest = rest.slice(name.length);
      break;
    }
  if (!rest.startsWith("/m/")) return undefined;
  const end = rest.indexOf("/", 3);
  const id = HostId.safeParse(end === -1 ? rest.slice(3) : rest.slice(3, end));
  if (!id.success) return undefined;
  const tail = end === -1 ? "" : rest.slice(end);
  const path = inserted + tail || "/";
  return { hostId: id.data, prefix: `/m/${id.data}`, path: path + url.search };
}
