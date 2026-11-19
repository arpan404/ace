import {
  ACE_APP_SIGN_IN_RETURN,
  ACE_WEB_SIGN_IN_PATH,
  type AceSignInReturnStatus,
} from "@ace/protocol/ace-account";

/**
 * The address a sign-in may send its browser back to: exactly the apps' `ace://` link, or the
 * web app's landing page on one of the allowed web origins. Anything else is refused, so the
 * backend never redirects anywhere a caller picks. Pure.
 */
export function allowedReturnTo(
  value: string,
  allowedOrigins: readonly string[],
): string | undefined {
  if (value === ACE_APP_SIGN_IN_RETURN) return value;
  for (const origin of allowedOrigins)
    if (origin.startsWith("http") && value === `${origin}${ACE_WEB_SIGN_IN_PATH}`) return value;
  return undefined;
}

/** The return address with how the sign-in ended: a status, never a token, code or login id. */
export function returnAddress(returnTo: string, status: AceSignInReturnStatus): string {
  return `${returnTo}?status=${status}`;
}
