/*
 * Pure, with no Node imports, so browser code (the fake daemon) compares origins exactly as the
 * daemon does through the `@ace/git/remote-url` export.
 */

const schemeUrl = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i;
// `[user@]host:path`, as Git reads it: no slash before the colon, and not a drive letter.
const scpUrl = /^(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+):(.*)$/;

/**
 * One key for every spelling of the same repository: `host/owner/repo` for network remotes
 * (scheme, user, port, trailing `.git` and slashes dropped, host lowercased, path case kept),
 * and the resolved path for local paths and `file://` URLs. Relative paths resolve against
 * `base` (the checkout Git would resolve them in).
 */
export function normalizeRemoteUrl(url: string, base = "/"): string {
  const value = url.trim();
  if (/^file:\/\//i.test(value)) return localPath(fileUrlPath(value), base);
  const scheme = schemeUrl.exec(value);
  if (scheme) return networkKey(hostOf(scheme[2] ?? ""), scheme[3] ?? "");
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("/") || value.startsWith("."))
    return localPath(value, base);
  const scp = scpUrl.exec(value);
  if (scp) return networkKey(hostOf(scp[1] ?? ""), scp[2] ?? "");
  return localPath(value, base);
}

function hostOf(authority: string): string {
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  return (bracketed ? (bracketed[1] ?? "") : host.replace(/:\d*$/, "")).toLowerCase();
}

function networkKey(host: string, path: string): string {
  const trimmed = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return trimmed ? `${host}/${trimmed}` : host;
}

function localPath(path: string, base: string): string {
  if (/^[a-z]:[\\/]/i.test(path)) return path.replace(/[\\/]+$/, "");
  return resolvePosix(base, path);
}

/**
 * The path a `file://` URL names: percent-decoded, a drive letter kept as the drive's path, and
 * a host other than localhost kept as `//host/…`. One that won't decode stays as written.
 */
function fileUrlPath(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  if (/^\/[a-z]:[\\/]/i.test(path)) return path.slice(1);
  return url.hostname ? `//${url.hostname}${path}` : path;
}

/** `path` resolved against `base` with POSIX rules: `.` and `..` folded, slashes collapsed. */
function resolvePosix(base: string, path: string): string {
  const parts: string[] = [];
  for (const segment of `${path.startsWith("/") ? "" : base}/${path}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}
