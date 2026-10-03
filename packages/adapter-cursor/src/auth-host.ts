import type { SdkModule } from "./host-runtime.ts";
import { SafeAuth } from "./contracts.ts";

export interface SdkAuthBoundary {
  sdk: { Cursor: Pick<SdkModule["Cursor"], "auth"> };
  environmentKeyPresent(): boolean;
  credentialFileAbsent(): Promise<boolean>;
  signal: AbortSignal;
  loginUrl(url: string): void;
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
    });
  } else if (method === "logout") {
    await sdk.Cursor.auth.logout();
    if (!(await boundary.credentialFileAbsent())) throw new Error("SDK credential file remains");
  }
  const stored = await sdk.Cursor.auth.status();
  return SafeAuth.parse(
    boundary.environmentKeyPresent()
      ? { status: "logged-in", source: "environment" }
      : { status: stored.status, source: stored.status === "logged-in" ? "sdk-store" : "none" },
  );
}
