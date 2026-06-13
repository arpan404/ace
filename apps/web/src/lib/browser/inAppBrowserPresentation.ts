import type { BrowserSessionStorage } from "~/lib/browser/session";
import { isBrowserInternalTabUrl } from "~/lib/browser/session";

export function isLikelyBrowserAuthenticationUrl(input: {
  title?: string | null;
  url: string | null;
}): boolean {
  if (!input.url) {
    return false;
  }
  try {
    const parsedUrl = new URL(input.url);
    const host = parsedUrl.hostname.toLowerCase();
    if (
      /(\.|^)secure\d*\.store\.apple\.com$/u.test(host) ||
      /(\.|^)idmsa\.apple\.com$/u.test(host)
    ) {
      return true;
    }
    const haystack =
      `${host} ${parsedUrl.pathname} ${parsedUrl.search} ${input.title ?? ""}`.toLowerCase();
    return /\b(auth|authorize|login|log-in|signin|sign-in|saml|sso|oauth|oidc|password|passkey|webauthn|account|checkout)\b/u.test(
      haystack,
    );
  } catch {
    return false;
  }
}

export function resolveMountedBrowserTabs(input: {
  activeTabId: string | null | undefined;
  retainInactiveTabs: boolean;
  tabs: BrowserSessionStorage["tabs"];
}): BrowserSessionStorage["tabs"] {
  if (input.retainInactiveTabs) {
    return input.tabs.filter((tab) => !isBrowserInternalTabUrl(tab.url));
  }

  const activeTabId = input.activeTabId ?? null;
  if (!activeTabId) return [];
  return input.tabs.filter((tab) => tab.id === activeTabId && !isBrowserInternalTabUrl(tab.url));
}

export function shouldPublishBrowserSessionChange(input: {
  previous: BrowserSessionStorage | null;
  next: BrowserSessionStorage;
  visible: boolean;
}): boolean {
  if (input.previous === input.next) {
    return false;
  }
  if (input.previous === null || input.visible) {
    return true;
  }
  if (input.previous.activeTabId !== input.next.activeTabId) {
    return true;
  }
  if (input.previous.tabs.length !== input.next.tabs.length) {
    return true;
  }
  return input.previous.tabs.some((tab, index) => input.next.tabs[index]?.id !== tab.id);
}
