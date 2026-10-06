import { z } from "zod";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { BackendOpen, BrowserCdp } from "./backend.ts";
import { HeadlessDownloads } from "./headless-downloads.ts";
const Start = z.object({
  guid: z.string().regex(/^native-[a-f0-9-]{36}$/),
  url: z.string().max(8192),
  filename: z.string().max(256),
  mimeType: z.string().max(256),
});
const Progress = z.object({
  guid: Start.shape.guid,
  bytes: z.number().nonnegative(),
  state: z.enum(["pending", "completed", "cancelled", "interrupted"]),
});
/** Native transport feeds the shared consent, privacy and artifact quarantine pipeline. */
export class EmbeddedDownloads {
  readonly transfers: HeadlessDownloads;
  private waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private request: BackendOpen;
  private cdp: BrowserCdp;
  constructor(request: BackendOpen, cdp: BrowserCdp) {
    this.request = request;
    this.cdp = cdp;
    this.transfers = new HeadlessDownloads(request);
  }
  handle(tabId: string, method: string, raw: unknown) {
    if (method === "ace.download.progress") {
      const result = Progress.safeParse(raw);
      if (!result.success) return;
      if (result.data.bytes > (this.request.maxDownloadBytes ?? 64 * 1024 * 1024))
        void this.cdp
          .send("ace.tabs.cdp", {
            tabId,
            method: "ace.download.cancel",
            params: { guid: result.data.guid },
          })
          .catch(() => {});
      if (result.data.state !== "pending") {
        const waiter = this.waiting.get(result.data.guid);
        this.waiting.delete(result.data.guid);
        if (result.data.state === "completed") waiter?.resolve();
        else waiter?.reject(new Error("Download failed"));
      }
      return;
    }
    if (method !== "ace.download.started" || !this.request.downloadDir) return;
    const start = Start.safeParse(raw);
    if (!start.success) return;
    const { guid, url, filename, mimeType } = start.data;
    const path = join(this.request.downloadDir, guid);
    const call = (command: string) =>
      this.cdp.send("ace.tabs.cdp", { tabId, method: command, params: { guid } });
    const done = new Promise<void>((resolve, reject) =>
      this.waiting.set(guid, { resolve, reject }),
    );
    void done.catch(() => {});
    this.transfers.response(url, mimeType);
    void this.transfers.accept(
      {
        suggestedFilename: () => filename,
        url: () => url,
        cancel: async () => {
          await call("ace.download.cancel");
          this.waiting.get(guid)?.reject(new Error("Download cancelled"));
          this.waiting.delete(guid);
        },
        delete: async () => {
          await rm(path, { force: true });
        },
        createReadStream: async () => {
          await call("ace.download.resume");
          await done;
          return createReadStream(path);
        },
      },
      tabId,
    );
  }
  stop() {
    for (const waiter of this.waiting.values()) waiter.reject(new Error("Browser closed"));
    this.waiting.clear();
  }
}
