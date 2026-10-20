/*
 * The GitHub avatar a reported URL names, as the one URL the daemon will fetch for it. Only a
 * user (`/u/<id>`) or app (`/in/<id>`) avatar on avatars.githubusercontent.com is read: the id and
 * the version or private-avatar token GitHub puts in the query, rebuilt onto that fixed host. Any
 * other host, path or form names no avatar, so a client can't point the daemon anywhere else.
 */

const host = "avatars.githubusercontent.com";
const path = /^\/(u|in)\/(\d{1,20})$/;
const token = /^[A-Za-z0-9_-]{1,128}$/;

/** The canonical URL to fetch, at twice the 32px the app draws; undefined when it names none. */
export function githubAvatarUrl(reported: string): string | undefined {
  let url: URL;
  try {
    url = new URL(reported);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password
  )
    return undefined;
  const match = path.exec(url.pathname);
  if (!match) return undefined;
  const query = new URLSearchParams();
  for (const name of ["u", "v"]) {
    const value = url.searchParams.get(name);
    if (value !== null && token.test(value)) query.set(name, value);
  }
  query.set("s", "64");
  return `https://${host}/${match[1]}/${match[2]}?${query.toString()}`;
}
