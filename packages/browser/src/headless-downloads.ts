import { mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Download } from "playwright-core";
import type { BrowserDownload } from "@ace/protocol";
import type { BackendOpen, BrowserCdp } from "./backend.ts";
import { z } from "zod";

export function downloadFlags(filename: string, mimeType: string): BrowserDownload["flags"] {
  const flags: BrowserDownload["flags"] = [];
  if (
    /\.(exe|msi|dmg|pkg|app|sh|bat|cmd|com|ps1|js|jar|deb|rpm)$/i.test(filename) ||
    /executable|x-sh|javascript/i.test(mimeType)
  )
    flags.push("executable");
  if (
    /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|jar)$/i.test(filename) ||
    /zip|compressed|archive|tar/i.test(mimeType)
  )
    flags.push("archive");
  return flags;
}
/** Quarantined artifacts never execute. Progress cancellation bounds Chromium's temporary file too. */
export class HeadlessDownloads {
  private privateMode = false;
  private privacyGeneration = 0;
  private transfers = new Map<AbortController, Download>();
  privacy(enabled: boolean): void {
    this.privateMode = enabled;
    this.privacyGeneration++;
    this.approved.clear();
    if (enabled)
      for (const [abort, download] of this.transfers) {
        abort.abort();
        void download.cancel().catch(() => {});
      }
  }
  private entries: BrowserDownload[] = [];
  private approved = new Map<string, number>();
  private mime = new Map<string, string>();
  private pending = 0;
  private sequence = 0;
  private total = 0;
  private request: BackendOpen;
  constructor(request: BackendOpen) {
    this.request = request;
  }
  list(): BrowserDownload[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
  async allowed(url: string): Promise<boolean> {
    if (this.privateMode) return false;
    if (this.entries.length + this.pending >= 128 || this.pending >= 4) return false;
    const generation = this.privacyGeneration;
    const allowed =
      (await this.request.allowed(url)) && (await this.request.downloadAllowed?.(url)) === true;
    this.request.signal.throwIfAborted();
    if (this.privateMode || generation !== this.privacyGeneration) return false;
    if (allowed) {
      if (this.approved.size >= 128) this.approved.clear();
      this.approved.set(url, (this.approved.get(url) ?? 0) + 1);
    }
    return allowed;
  }
  response(url: string, mime: string): void {
    if (this.mime.size >= 256) this.mime.delete(this.mime.keys().next().value ?? "");
    this.mime.set(url, mime.split(";")[0]?.slice(0, 256) || "application/octet-stream");
  }
  async progress(cdp: BrowserCdp): Promise<void> {
    const limit = this.request.maxDownloadBytes ?? 64 * 1024 * 1024;
    cdp.on("Browser.downloadProgress", (raw) => {
      const parsed = z.object({ guid: z.string(), receivedBytes: z.number() }).safeParse(raw);
      if (parsed.success && parsed.data.receivedBytes > limit)
        void cdp.send("Browser.cancelDownload", { guid: parsed.data.guid }).catch(() => {});
    });
    if (this.request.downloadDir)
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: this.request.downloadDir,
        eventsEnabled: true,
      });
  }
  async accept(download: Download, tabId: string): Promise<void> {
    if (
      this.privateMode ||
      this.pending >= 4 ||
      this.entries.length >= 128 ||
      !this.request.downloadDir
    ) {
      await download.cancel();
      return;
    }
    this.pending++;
    const abort = new AbortController();
    this.transfers.set(abort, download);
    const signal = AbortSignal.any([this.request.signal, abort.signal]);
    const filename =
      basename(download.suggestedFilename())
        .replace(/[/\\]/g, "_")
        .split("")
        .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
        .join("")
        .slice(0, 256) || "download";
    const mimeType = this.mime.get(download.url()) ?? "application/octet-stream";
    const entry: BrowserDownload = {
      downloadId: `download-${this.request.id?.() ?? ++this.sequence}`,
      tabId,
      filename,
      mimeType,
      flags: downloadFlags(filename, mimeType),
      state: "pending",
      bytes: 0,
    };
    this.entries.push(entry);
    this.request.changed?.();
    const path = join(this.request.downloadDir, `${entry.downloadId}-${filename}`);
    try {
      const grants = this.approved.get(download.url()) ?? 0;
      if (grants > 0) this.approved.set(download.url(), grants - 1);
      else if (!(await this.allowed(download.url()))) {
        entry.state = "denied";
        await download.cancel();
        return;
      }
      signal.throwIfAborted();
      await mkdir(this.request.downloadDir, { recursive: true, mode: 0o700 });
      const stream = await download.createReadStream();
      if (!stream) throw new Error("Download stream unavailable");
      signal.throwIfAborted();
      const limit = this.request.maxDownloadBytes ?? 64 * 1024 * 1024;
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          if (
            entry.bytes + chunk.byteLength > limit ||
            this.total + chunk.byteLength > 256 * 1024 * 1024
          ) {
            entry.state = "too_large";
            callback(new Error("Download size limit"));
            return;
          }
          entry.bytes += chunk.byteLength;
          this.total += chunk.byteLength;
          callback(null, chunk);
        },
      });
      await pipeline(stream, counter, createWriteStream(path, { flags: "wx", mode: 0o600 }), {
        signal,
      });
      signal.throwIfAborted();
      entry.state = "complete";
      entry.path = path;
      await this.request.artifact?.({
        path,
        mimeType,
        bytes: entry.bytes,
        filename,
        flags: entry.flags,
      });
    } catch {
      if (entry.state === "pending") entry.state = abort.signal.aborted ? "denied" : "failed";
      await rm(path, { force: true });
      await download.cancel().catch(() => {});
    } finally {
      this.pending--;
      this.transfers.delete(abort);
      this.request.changed?.();
      // Chromium's transient GUID file must not double the quarantine budget.
      await download.delete().catch(() => {});
    }
  }
}
