import { HostedAddress } from "@ace/protocol/ace-account";

/** The key a session for `origin` is saved under: a former address of ace's backend is the current one. */
export function savedOriginKey(origin: string): string {
  return HostedAddress.parse(origin);
}

/**
 * The app's saved sessions as stored, with a session saved under a former address of ace's
 * backend moved to the current one, so the person stays signed in after the move. A session
 * already saved under the current address wins.
 */
export function sessionsByCurrentOrigin(
  saved: Readonly<Record<string, string>>,
): Record<string, string> {
  const current: Record<string, string> = {};
  for (const [origin, token] of Object.entries(saved))
    if (savedOriginKey(origin) === origin) current[origin] = token;
  for (const [origin, token] of Object.entries(saved)) {
    const key = savedOriginKey(origin);
    if (key !== origin && current[key] === undefined) current[key] = token;
  }
  return current;
}
