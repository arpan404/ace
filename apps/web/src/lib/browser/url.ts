import {
  normalizeWsUrl,
  splitWsUrlAuthToken,
  wsUrlToBrowserBaseUrl,
} from "@ace/shared/hostConnections";
import {
  DEFAULT_BROWSER_HOME_URL,
  normalizeBrowserHttpUrl,
  normalizeBrowserInput,
  resolveBrowserHomeUrl,
  resolveBrowserInputTarget,
  type BrowserInputIntent,
} from "@ace/shared/browserUrl";

const BROWSER_RELAY_PATHNAME = "/api/browser-relay";

export {
  DEFAULT_BROWSER_HOME_URL,
  normalizeBrowserHttpUrl,
  normalizeBrowserInput,
  resolveBrowserHomeUrl,
  resolveBrowserInputTarget,
  type BrowserInputIntent,
};

export function isBrowserRelayTargetUrl(rawUrl: string): boolean {
  return normalizeBrowserHttpUrl(rawUrl) !== null;
}

export function resolveBrowserRelayUrl(input: {
  readonly url: string;
  readonly ownerConnectionUrl?: string | null | undefined;
  readonly localConnectionUrl?: string | null | undefined;
}): string {
  const normalizedUrl = normalizeBrowserHttpUrl(input.url);
  if (!normalizedUrl || !input.ownerConnectionUrl || !isBrowserRelayTargetUrl(normalizedUrl)) {
    return input.url;
  }

  try {
    const ownerConnection = splitWsUrlAuthToken(input.ownerConnectionUrl);
    if (
      input.localConnectionUrl &&
      normalizeWsUrl(ownerConnection.wsUrl) ===
        normalizeWsUrl(splitWsUrlAuthToken(input.localConnectionUrl).wsUrl)
    ) {
      return input.url;
    }
    const relayUrl = new URL(
      BROWSER_RELAY_PATHNAME,
      wsUrlToBrowserBaseUrl(input.ownerConnectionUrl),
    );
    relayUrl.searchParams.set("url", normalizedUrl);
    if (ownerConnection.authToken) {
      relayUrl.searchParams.set("token", ownerConnection.authToken);
    }
    return relayUrl.toString();
  } catch {
    return input.url;
  }
}

export function resolveBrowserDisplayUrl(rawUrl: string): string {
  const normalizedUrl = normalizeBrowserHttpUrl(rawUrl);
  if (!normalizedUrl) {
    return rawUrl;
  }

  const parsed = new URL(normalizedUrl);
  if (parsed.pathname !== BROWSER_RELAY_PATHNAME) {
    return rawUrl;
  }
  return parsed.searchParams.get("url") ?? rawUrl;
}
