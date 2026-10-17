/**
 * What ace for Chrome lets the daemon touch (ADR 0084). Pure, so the rules are tested directly.
 */

/** Pages ace never attaches to or navigates to, beyond every non-web scheme. */
const sensitivePages: { host: string; path?: string }[] = [
  { host: "chromewebstore.google.com" },
  { host: "chrome.google.com", path: "/webstore" },
  { host: "microsoftedge.microsoft.com", path: "/addons" },
  { host: "passwords.google.com" },
  { host: "passwords.google" },
];

/** A controlled tab may show only ordinary web pages (and the blank page a new tab starts on). */
export function pageAllowed(raw: string): boolean {
  if (raw === "about:blank" || raw === "") return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return !sensitivePages.some(
    (page) =>
      (host === page.host || host.endsWith(`.${page.host}`)) &&
      (page.path === undefined || url.pathname.startsWith(page.path)),
  );
}

const allowedDomains = new Set([
  "Page",
  "Runtime",
  "DOM",
  "DOMSnapshot",
  "CSS",
  "Accessibility",
  "Input",
  "Emulation",
  "Network",
  "Log",
  "Overlay",
]);
/** Credential and cross-site state readers inside otherwise allowed domains. */
const deniedMethods = new Set([
  "Network.getCookies",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.setExtraHTTPHeaders",
  "Network.loadNetworkResource",
  "Page.setDownloadBehavior",
]);

/** CDP methods the daemon may send to a controlled tab. */
export function cdpAllowed(method: string): boolean {
  const domain = method.split(".", 1)[0] ?? "";
  return allowedDomains.has(domain) && !deniedMethods.has(method);
}

/** The URL a CDP command would load, when it loads one. */
export function cdpNavigation(method: string, params: Record<string, unknown> | undefined) {
  if (method !== "Page.navigate") return undefined;
  return typeof params?.url === "string" ? params.url : "";
}
