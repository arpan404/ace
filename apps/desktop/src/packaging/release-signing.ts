/**
 * How a macOS release is signed and notarized, decided from the environment before a long
 * build starts, so a missing credential fails in seconds rather than after packaging.
 */

export type Notary =
  | { kind: "apple-id" | "api-key" | "keychain-profile" }
  | { kind: "none" }
  | { kind: "incomplete"; missing: string[] };

/**
 * The notarytool credentials electron-builder will use, in its own order: an Apple ID with
 * an app-specific password, then an App Store Connect API key, then a profile saved with
 * `xcrun notarytool store-credentials`. A half-set group is an error, as it is there.
 */
export function notaryCredentials(env: NodeJS.ProcessEnv): Notary {
  const missing = (names: string[]) => names.filter((name) => !env[name]);
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    const absent = missing(["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]);
    return absent.length ? { kind: "incomplete", missing: absent } : { kind: "apple-id" };
  }
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    const absent = missing(["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]);
    return absent.length ? { kind: "incomplete", missing: absent } : { kind: "api-key" };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) return { kind: "keychain-profile" };
  return { kind: "none" };
}

/** "Developer ID Application" identities in `security find-identity -v -p codesigning` output. */
export function developerIdIdentities(findIdentity: string): string[] {
  const names: string[] = [];
  for (const line of findIdentity.split("\n")) {
    const match = /^\s*\d+\)\s+[0-9A-F]{40}\s+"(Developer ID Application: [^"]+)"/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}
