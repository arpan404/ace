/*
 * Which top-level navigations to the machine's loopback a device tab lets through (ADR 0194,
 * "Public pages don't reach the machine's localhost"). A request rule keyed on the top-level URL
 * can't judge a top-level navigation, whose own URL is the top URL; this does, for the desktop
 * app and the phone alike. The phone's WebKit policy can't call into the script while it decides,
 * so Swift keeps the same rule and both are tested against `loopback-navigation-cases.json`.
 * Pure.
 */

export interface LoopbackNavigation {
  /** The request's method as sent, or as the browser reports it before a redirect. */
  method: string;
  /**
   * The document that started the navigation is itself on a loopback host. For a form the
   * browser resubmits (a reload or a move back or forward to a page a POST made), the document
   * the browser names for it.
   */
  initiatorIsLoopback: boolean;
  /** When this request follows a redirect: its status (301, 302, 303, 307, 308). */
  redirectStatus?: number;
}

/** The method a redirect sends on: 303 makes it a GET, 301 and 302 make a POST one. */
export function redirectedMethod(method: string, redirectStatus?: number): string {
  const upper = method.toUpperCase();
  if (redirectStatus === 303 && upper !== "HEAD") return "GET";
  if ((redirectStatus === 301 || redirectStatus === 302) && upper === "POST") return "GET";
  return upper;
}

/**
 * Whether a top-level navigation to the machine's loopback may go ahead. It may when the
 * document that started it is on loopback, or when it is a GET: a link, a script setting
 * `location`, a redirect chain whose request to loopback is a GET (an OAuth provider's 302 or 303
 * back to localhost), and every navigation the person starts in ace (an address, a tab, a reload,
 * a move back or forward, and their redirects), which are all GETs. Any other non-GET is refused:
 * a form posted by a public page, a 307 or 308 that keeps its POST, and a POST the browser
 * resubmits for a page that isn't on loopback, whoever asked for the reload. No navigation is
 * trusted for who started it.
 */
export function loopbackNavigationAllowed(navigation: LoopbackNavigation): boolean {
  if (navigation.initiatorIsLoopback) return true;
  return redirectedMethod(navigation.method, navigation.redirectStatus) === "GET";
}
