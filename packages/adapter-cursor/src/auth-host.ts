import type { SdkModule } from "./host-runtime.ts";
import { SafeAuth } from "./contracts.ts";

export interface SdkAuthBoundary {
  sdk: { Cursor: Pick<SdkModule["Cursor"], "auth"> };
  environmentKeyPresent(): boolean;
  environmentKeyUsable?(): boolean;
  credentialFileAbsent(): Promise<boolean>;
  signal: AbortSignal;
  loginUrl(url: string): void;
  /** The name the minted key gets in Cursor's dashboard, so the person can tell it is ace's. */
  keyName?: string;
}
/** Keys from official login are deliberately unreachable outside this host operation. */
export async function cursorAuthInHost(
  method: "status" | "login" | "logout",
  boundary: SdkAuthBoundary,
) {
  const { sdk } = boundary;
  if (method === "login") {
    await sdk.Cursor.auth.login({
      openBrowser: false,
      signal: boundary.signal,
      onLoginUrl: boundary.loginUrl,
      apiKeyName: boundary.keyName ?? "ace",
    });
  } else if (method === "logout") {
    await sdk.Cursor.auth.logout();
    if (!(await boundary.credentialFileAbsent())) throw new Error("SDK credential file remains");
  }
  const stored = await sdk.Cursor.auth.status();
  // The account and key expiry the SDK's own login recorded; never the key itself.
  return SafeAuth.parse(
    boundary.environmentKeyPresent()
      ? {
          status: boundary.environmentKeyUsable?.() === false ? "logged-out" : "logged-in",
          source: "environment",
        }
      : stored.status === "logged-in"
        ? {
            status: "logged-in",
            source: "sdk-store",
            ...(stored.email ? { email: stored.email.slice(0, 256) } : {}),
            ...(stored.apiKeyExpiresAtMs !== undefined && stored.apiKeyExpiresAtMs >= 0
              ? { expiresAt: stored.apiKeyExpiresAtMs }
              : {}),
          }
        : { status: "logged-out", source: "none" },
  );
}
