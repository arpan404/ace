import type { BrowserState, BrowserTab } from "@ace/protocol";
import {
  addressHost,
  describeBrowserFailure,
  displayAddress,
  downloadStateLabels,
  sitePermissionLabel,
  zoomLabel,
  type BrowserFailure,
} from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * The thread's browser as the phone draws it: what each tab is, who is using the shown one, and
 * everything that stands between the person and its page (a dialog, a sign-in, a file picker, a
 * certificate, a failed load). Pure: the live view (`browser-live.ts`) sends it on each change.
 */

/** Tabs listed in the tabs sheet; the rest are counted. */
export const tabLimit = 20;
const downloadLimit = 50;

/** A navigation this phone started in a tab, while it loads or after it failed. */
export type Navigation =
  | { tabId: string; url: string; from: string | undefined; failure?: undefined }
  | { tabId: string; url: string; from: string | undefined; failure: BrowserFailure };

export interface ViewContext {
  preview: Preview;
  /** The agent's name ("Claude", "Reviewer") for an agent id; `undefined` reads "An agent". */
  agentName(agentId: string | undefined): string;
  navigation: Navigation | undefined;
}

const blank = (url: string | undefined) => !url || url === "about:blank";

/** Whose turn the page is: an agent using it now, or agents kept out of it by the person. */
function control(tab: BrowserTab, context: ViewContext) {
  return {
    agent:
      tab.inUse?.kind === "agent"
        ? context.preview(context.agentName(tab.inUse.agentId), 64)
        : null,
    private: tab.private === true,
  };
}

/** The tab a page prompt belongs to: the shown tab's first, then any other tab's. */
function prompted<K extends "pending_auth" | "file_chooser">(
  tabs: readonly BrowserTab[],
  activeTabId: string | undefined,
  key: K,
): BrowserTab | undefined {
  return tabs.find((tab) => tab.tabId === activeTabId && tab[key]) ?? tabs.find((tab) => tab[key]);
}

const site = (url: string | undefined, preview: Preview) =>
  preview(addressHost(url ?? "") ?? "This page", 128);

function failureOf(
  state: BrowserState,
  shown: BrowserTab | undefined,
  navigation: Navigation | undefined,
): (BrowserFailure & { url: string }) | null {
  if (navigation?.failure && navigation.tabId === shown?.tabId)
    return { ...navigation.failure, url: navigation.url };
  if (shown && !blank(shown.url) && state.loadError && state.url === shown.url)
    return { ...describeBrowserFailure(state.loadError, shown.url), url: shown.url };
  return null;
}

/** The view's state for Swift; labels shortened for display, ids and values kept exact. */
export function browserViewState(state: BrowserState, context: ViewContext) {
  const { preview } = context;
  const tabs = state.closed ? [] : (state.tabs ?? []);
  const shown = tabs.find((tab) => tab.tabId === state.activeTabId);
  const navigation =
    context.navigation && tabs.some((tab) => tab.tabId === context.navigation?.tabId)
      ? context.navigation
      : undefined;
  const url =
    navigation?.tabId === shown?.tabId && navigation ? navigation.url : (shown?.url ?? state.url);
  const dialog = state.pending_dialog ?? tabs.find((tab) => tab.pending_dialog)?.pending_dialog;
  const dialogTab = dialog ? tabs.find((tab) => tab.tabId === dialog.tabId) : undefined;
  const authTab = prompted(tabs, state.activeTabId, "pending_auth");
  const chooserTab = prompted(tabs, state.activeTabId, "file_chooser");
  const certificate = shown?.certificate_error;
  const failure = failureOf(state, shown, navigation);
  const downloads = state.downloads ?? [];
  return {
    url: preview(state.url, 2048),
    closed: state.closed,
    status: state.status ?? "ready",
    reason: state.reason ? preview(state.reason, 512) : null,
    loading:
      state.loading === true ||
      shown?.loading === true ||
      (navigation !== undefined && !navigation.failure && navigation.tabId === shown?.tabId),
    loadError: state.loadError ? preview(state.loadError, 512) : null,
    activeTabId: state.activeTabId ?? null,
    tabs: tabs.slice(0, tabLimit).map((tab) => {
      const who = control(tab, context);
      return {
        id: tab.tabId,
        title: preview(tab.title || tab.label || addressHost(tab.url) || tab.url || "New tab", 120),
        url: preview(tab.url, 512),
        host: preview(addressHost(tab.url) ?? "", 128),
        loading: tab.loading === true,
        agent: who.agent,
        private: who.private,
      };
    }),
    moreTabs: Math.max(0, tabs.length - tabLimit),
    /** The address the bar shows: what loads or failed here, else the shown tab's own. */
    address: preview(displayAddress(url), 2048),
    addressUrl: preview(blank(url) ? "" : url, 8192),
    /** The bar at rest shows the site alone, as Safari's does. */
    addressHost: preview(addressHost(url) ?? "", 256),
    blank: !state.closed && blank(url),
    shown: shown
      ? {
          canGoBack: shown.canGoBack === true,
          canGoForward: shown.canGoForward === true,
          zoom: shown.zoom && Math.abs(shown.zoom - 1) > 0.005 ? zoomLabel(shown.zoom) : null,
          ...control(shown, context),
          // The daemon draws agents' cursors in the page itself when it says so.
          pointer:
            shown.inUse?.kind === "agent" &&
            shown.pointer &&
            !state.features?.includes("page-cursor")
              ? shown.pointer
              : null,
        }
      : null,
    /** The browser lost its pages; Reopen brings them back at their last addresses. */
    disconnected: state.status === "paused" && state.pageStateLost === true,
    failure: failure
      ? {
          title: preview(failure.title, 256),
          detail: preview(failure.detail, 512),
          url: preview(failure.url, 2048),
          host: site(failure.url, preview),
        }
      : null,
    certificate: certificate
      ? (() => {
          const described = describeBrowserFailure(`net::${certificate.error}`, certificate.url);
          return {
            title: preview(described.title, 256),
            detail: preview(described.detail, 512),
            url: preview(certificate.url, 8192),
            host: site(certificate.url, preview),
          };
        })()
      : null,
    dialog: dialog
      ? {
          dialogId: dialog.dialogId,
          tabId: dialog.tabId,
          type: dialog.type,
          message: preview(dialog.message, 4096),
          defaultPrompt: dialog.defaultPrompt ?? "",
          site: site(dialogTab?.url ?? state.url, preview),
          otherTab: dialog.tabId !== state.activeTabId,
        }
      : null,
    auth: authTab?.pending_auth
      ? {
          authId: authTab.pending_auth.authId,
          tabId: authTab.tabId,
          site: site(authTab.pending_auth.origin, preview),
          realm: authTab.pending_auth.realm ? preview(authTab.pending_auth.realm, 256) : null,
          otherTab: authTab.tabId !== state.activeTabId,
        }
      : null,
    chooser: chooserTab?.file_chooser
      ? {
          chooserId: chooserTab.file_chooser.chooserId,
          tabId: chooserTab.tabId,
          multiple: chooserTab.file_chooser.multiple,
          site: site(chooserTab.url, preview),
          otherTab: chooserTab.tabId !== state.activeTabId,
        }
      : null,
    permission: state.permissionDenied
      ? `Site access blocked: ${sitePermissionLabel(state.permissionDenied.permission)}`
      : null,
    downloads: downloads
      .slice(-downloadLimit)
      .toReversed()
      .map((download) => ({
        id: download.downloadId,
        filename: preview(download.filename, 256),
        state: downloadStateLabels[download.state],
        failed: download.state === "failed" || download.state === "denied",
        bytes: download.bytes,
        risky: download.flags.includes("executable"),
      })),
    downloading: downloads.filter((download) => download.state === "pending").length,
  };
}
