/*
 * Pure, with no Node imports, so browser code (the fake daemon) compares origins exactly as the
 * daemon does through the `@ace/git/remote-url` export.
 */

const schemeUrl = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i;
// `[user@]host:path`, as Git reads it: no slash before the colon, and not a drive letter.
const scpUrl = /^(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+):(.*)$/;

/** Ports a scheme reaches by default; any other port is part of the repository's address. */
const defaultPorts: Record<string, string> = {
  ssh: "22",
  "git+ssh": "22",
  "ssh+git": "22",
  git: "9418",
  http: "80",
  https: "443",
};

/**
 * One key for every spelling of the same repository: `host/owner/repo` for network remotes
 * (scheme, user, the scheme's default port, trailing `.git` and slashes dropped, host
 * lowercased, path case kept; another port stays, as `host:2222/owner/repo`),
 * and the resolved path for local paths and `file://` URLs. Relative paths resolve against
 * `base` (the checkout Git would resolve them in).
 */
export function normalizeRemoteUrl(url: string, base = "/"): string {
  const value = url.trim();
  if (/^file:\/\//i.test(value)) return localPath(fileUrlPath(value), base);
  const scheme = schemeUrl.exec(value);
  if (scheme) {
    const port = defaultPorts[(scheme[1] ?? "").toLowerCase()];
    return networkKey(addressOf(scheme[2] ?? "", port), scheme[3] ?? "");
  }
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("/") || value.startsWith("."))
    return localPath(value, base);
  const scp = scpUrl.exec(value);
  if (scp) return networkKey(addressOf(scp[1] ?? "", undefined), scp[2] ?? "");
  return localPath(value, base);
}

/**
 * The authority's host, lowercased, with its port unless that is `defaultPort` or empty. An
 * scp-style remote has no port (`host:2222/x` is the path `2222/x`), so it passes undefined.
 */
function addressOf(authority: string, defaultPort: string | undefined): string {
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const parts = /^(\[[^\]]+\]|[^:]*)(?::(\d*))?$/.exec(hostPort);
  const raw = parts?.[1] ?? hostPort;
  const host = (raw.startsWith("[") ? raw.slice(1, -1) : raw).toLowerCase();
  const port = parts?.[2]?.replace(/^0+(?=\d)/, "");
  return port && port !== defaultPort ? `${host}:${port}` : host;
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
  // A drive's root keeps its slash (`C:/`), so it still reads as a path on this machine.
  if (/^[a-z]:[\\/]/i.test(path)) {
    const trimmed = path.replace(/[\\/]+$/, "");
    return /^[a-z]:$/i.test(trimmed) ? `${trimmed}/` : trimmed;
  }
  return resolvePosix(base, path);
}

/**
 * Whether a key names a path on this machine's own disk rather than a network address: a POSIX
 * path, a `file://` URL's path, a share (`//host/…`), a drive or a drive's root. The same path on
 * two machines is two unrelated repositories.
 */
export function isLocalRemoteKey(key: string): boolean {
  return key.startsWith("/") || key.startsWith("\\") || /^[a-z]:([\\/]|$)/i.test(key);
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
