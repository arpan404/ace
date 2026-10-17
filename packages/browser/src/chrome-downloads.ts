import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BackendOpen, BrowserCdp } from "./backend.ts";
import { HeadlessDownloads } from "./headless-downloads.ts";

const Begin = z.object({
  guid: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  url: z.string().max(8192),
  suggestedFilename: z.string().max(4096),
});
const Progress = z.object({
  guid: z.string(),
  receivedBytes: z.number().nonnegative(),
  state: z.string(),
});
const Response = z.object({
  response: z.object({ url: z.string().max(8192), mimeType: z.string().max(256) }),
});
/** Where Chrome is currently writing: the staging directory and the tab's cookie jar. */
export interface DownloadHost {
  root: BrowserCdp;
  stagingDir: string;
  browserContextId?: string | undefined;
}

/**
 * Chrome writes each download, named by GUID, into ace's staging directory. The shared consent,
 * privacy and quarantine pipeline then copies finished bytes into the session's artifacts.
 */
export class ChromeDownloads {
  readonly transfers: HeadlessDownloads;
  private waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private request: BackendOpen;
  private host: () => DownloadHost | undefined;
  constructor(request: BackendOpen, host: () => DownloadHost | undefined) {
    this.request = request;
    this.host = host;
    this.transfers = new HeadlessDownloads(request);
  }
  /** Follows one tab's downloads; returns the unsubscribe. */
  watch(tabId: string, cdp: BrowserCdp): () => void {
    const begin = (raw: unknown) => this.begin(tabId, raw);
    const progress = (raw: unknown) => this.progress(raw);
    const response = (raw: unknown) => {
      const parsed = Response.safeParse(raw);
      if (parsed.success)
        this.transfers.response(parsed.data.response.url, parsed.data.response.mimeType);
    };
    cdp.on("Page.downloadWillBegin", begin);
    cdp.on("Page.downloadProgress", progress);
    cdp.on("Network.responseReceived", response);
    return () => {
      cdp.off("Page.downloadWillBegin", begin);
      cdp.off("Page.downloadProgress", progress);
      cdp.off("Network.responseReceived", response);
    };
  }
  stop(): void {
    for (const waiter of this.waiting.values()) waiter.reject(new Error("Browser closed"));
    this.waiting.clear();
  }
  private progress(raw: unknown): void {
    const parsed = Progress.safeParse(raw);
    if (!parsed.success || !this.waiting.has(parsed.data.guid)) return;
    const { guid, receivedBytes, state } = parsed.data;
    if (receivedBytes > (this.request.maxDownloadBytes ?? 64 * 1024 * 1024))
      void this.cancel(guid).catch(() => {});
    if (state === "inProgress") return;
    const waiter = this.waiting.get(guid);
    this.waiting.delete(guid);
    if (state === "completed") waiter?.resolve();
    else waiter?.reject(new Error("Download failed"));
  }
  private cancel(guid: string): Promise<unknown> {
    const host = this.host();
    if (!host) return Promise.resolve();
    return host.root.send("Browser.cancelDownload", {
      guid,
      ...(host.browserContextId ? { browserContextId: host.browserContextId } : {}),
    });
  }
  private begin(tabId: string, raw: unknown): void {
    const parsed = Begin.safeParse(raw);
    const host = this.host();
    if (!parsed.success || !host) return;
    const { guid, url, suggestedFilename } = parsed.data;
    const path = join(host.stagingDir, guid);
    const done = new Promise<void>((resolve, reject) =>
      this.waiting.set(guid, { resolve, reject }),
    );
    void done.catch(() => {});
    void this.transfers
      .accept(
        {
          suggestedFilename: () => suggestedFilename,
          url: () => url,
          cancel: async () => {
            try {
              await this.cancel(guid);
            } finally {
              this.waiting.get(guid)?.reject(new Error("Download cancelled"));
              this.waiting.delete(guid);
            }
          },
          delete: async () => {
            await rm(path, { force: true });
          },
          createReadStream: async () => {
            await done;
            return createReadStream(path);
          },
        },
        tabId,
      )
      .catch(() => {});
  }
}
