import type { BrowserDownload } from "@ace/protocol";

/*
 * The browser's fixed wording, shared by every client that shows a thread's browser: why typed
 * text isn't an address, which site permission was blocked, and where a download stands.
 */

/** Why the address bar refused what was typed (`parseAddress`'s reasons). */
export const addressProblems = {
  empty: "Type an address, like localhost:3000 or example.com.",
  not_address: "That isn't an address. Try one like localhost:3000 or example.com.",
  scheme: "ace's browser opens web pages (http and https) only.",
} as const;

/** A blocked site permission (`BrowserState.permissionDenied`) in the person's words. */
export function sitePermissionLabel(permission: string): string {
  return (
    (
      {
        media: "camera or microphone",
        geolocation: "location",
        notifications: "notifications",
        "clipboard-sanitized-write": "clipboard",
      } as Record<string, string>
    )[permission] ?? "a site permission"
  );
}

/** Where a download stands, as one word. */
export const downloadStateLabels: Record<BrowserDownload["state"], string> = {
  pending: "Downloading",
  complete: "Downloaded",
  denied: "Blocked",
  failed: "Failed",
  too_large: "Too large",
};
