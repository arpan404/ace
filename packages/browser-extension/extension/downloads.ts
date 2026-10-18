import type { UserBrowserDownload, UserBrowserExtensionMessage } from "@ace/protocol";
import type { ChromeApi, ChromeDownloadItem } from "./chrome-api.ts";

/** How long a tab's `Page.downloadWillBegin` waits for the browser's download item. */
const pairingMs = 30_000;

/**
 * Reports downloads that a controlled tab started (ADR 0086) and nothing else: the person's own
 * downloads stay unseen. A tab's `Page.downloadWillBegin` names the URL; the browser's download
 * item for that URL is then followed until it completes. Files stay where the browser saved them.
 */
export class DownloadReporter {
  private chrome: ChromeApi;
  private post: (message: UserBrowserExtensionMessage) => void;
  private now: () => number;
  /** URLs controlled tabs are about to download, oldest first. */
  private expected: { tabId: number; url: string; at: number }[] = [];
  /** Download item ids to the controlled tab that started them. */
  private owners = new Map<number, number>();
  constructor(
    chrome: ChromeApi,
    post: (message: UserBrowserExtensionMessage) => void,
    now: () => number,
  ) {
    this.chrome = chrome;
    this.post = post;
    this.now = now;
    chrome.downloads?.onCreated.addListener((item) => this.created(item));
    chrome.downloads?.onChanged.addListener((delta) => void this.changed(delta.id));
  }
  /** A controlled tab's CDP event; only `Page.downloadWillBegin` matters here. */
  pageEvent(tabId: number, method: string, params: unknown): void {
    if (method !== "Page.downloadWillBegin" || typeof params !== "object" || params === null)
      return;
    const url: unknown = Reflect.get(params, "url");
    if (typeof url !== "string") return;
    const at = this.now();
    this.expected = this.expected.filter((entry) => at - entry.at < pairingMs).slice(-31);
    this.expected.push({ tabId, url, at });
  }
  private created(item: ChromeDownloadItem): void {
    const index = this.expected.findIndex(
      (entry) => entry.url === item.url || entry.url === item.finalUrl,
    );
    const entry = this.expected[index];
    if (!entry || this.owners.size >= 256) return;
    this.expected.splice(index, 1);
    this.owners.set(item.id, entry.tabId);
    this.report(entry.tabId, item);
  }
  private async changed(id: number): Promise<void> {
    const tabId = this.owners.get(id);
    if (tabId === undefined || !this.chrome.downloads) return;
    const [item] = await this.chrome.downloads.search({ id }).catch(() => []);
    if (!item) return;
    this.report(tabId, item);
    if (item.state !== "in_progress") this.owners.delete(id);
  }
  private report(tabId: number, item: ChromeDownloadItem): void {
    const download: UserBrowserDownload = {
      id: item.id,
      filename: baseName(item.filename).slice(0, 256),
      path: item.filename.slice(0, 4096),
      state: item.state,
      bytes: Math.max(
        0,
        item.state === "complete" ? item.totalBytes || item.bytesReceived : item.bytesReceived,
      ),
      mimeType: item.mime.slice(0, 256),
    };
    this.post({ type: "user_browser.event", event: { kind: "download", tabId, download } });
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}
