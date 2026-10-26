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

/**
 * How a Windows release is Authenticode-signed, from the environment; nothing is committed.
 * - `certificate`: a PFX in `WIN_CSC_LINK` (path, URL or base64) with `WIN_CSC_KEY_PASSWORD`,
 *   which electron-builder reads itself.
 * - `azure`: Azure Trusted Signing, with the `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/
 *   `AZURE_CLIENT_SECRET` service principal electron-builder's signer reads.
 * Both need `ACE_WINDOWS_PUBLISHER`, the certificate's subject common name: electron-updater
 * installs only an update signed by that publisher. `none` builds an unsigned package.
 */
export type WindowsSigning =
  | { kind: "certificate"; publisherName: string }
  | {
      kind: "azure";
      publisherName: string;
      endpoint: string;
      codeSigningAccountName: string;
      certificateProfileName: string;
    }
  | { kind: "none" }
  | { kind: "incomplete"; missing: string[] };

export function windowsSigning(env: NodeJS.ProcessEnv): WindowsSigning {
  const missing = (names: string[]) => names.filter((name) => !env[name]);
  const azure = [
    "ACE_AZURE_SIGNING_ENDPOINT",
    "ACE_AZURE_SIGNING_ACCOUNT",
    "ACE_AZURE_CERTIFICATE_PROFILE",
  ];
  if (azure.some((name) => env[name])) {
    const absent = missing([
      ...azure,
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "ACE_WINDOWS_PUBLISHER",
    ]);
    if (absent.length) return { kind: "incomplete", missing: absent };
    return {
      kind: "azure",
      publisherName: env.ACE_WINDOWS_PUBLISHER ?? "",
      endpoint: env.ACE_AZURE_SIGNING_ENDPOINT ?? "",
      codeSigningAccountName: env.ACE_AZURE_SIGNING_ACCOUNT ?? "",
      certificateProfileName: env.ACE_AZURE_CERTIFICATE_PROFILE ?? "",
    };
  }
  if (env.WIN_CSC_LINK) {
    const absent = missing(["WIN_CSC_KEY_PASSWORD", "ACE_WINDOWS_PUBLISHER"]);
    if (absent.length) return { kind: "incomplete", missing: absent };
    return { kind: "certificate", publisherName: env.ACE_WINDOWS_PUBLISHER ?? "" };
  }
  return { kind: "none" };
}

/** electron-builder's `win` signing settings for `signing`; empty for an unsigned build. */
export function windowsSigningConfig(signing: WindowsSigning): Record<string, unknown> {
  if (signing.kind === "certificate")
    return {
      signtoolOptions: {
        publisherName: [signing.publisherName],
        signingHashAlgorithms: ["sha256"],
        rfc3161TimeStampServer: "http://timestamp.digicert.com",
      },
    };
  if (signing.kind === "azure") {
    const { kind: _kind, ...options } = signing;
    return { azureSignOptions: options };
  }
  return {};
}
