import { mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { saveInFolder } from "./download-folder.ts";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
interface Download {
  suggestedFilename(): string;
  url(): string;
  cancel(): Promise<void>;
  delete(): Promise<void>;
  createReadStream(): Promise<Readable | null>;
}
import type { BrowserDownload } from "@ace/protocol";
import type { BackendOpen, DownloadSource } from "./backend.ts";
import { PolicyGate } from "./policy-call.ts";

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
    if (enabled)
      for (const [abort, download] of this.transfers) {
        abort.abort();
        void download.cancel().catch(() => {});
      }
  }
  private entries: BrowserDownload[] = [];
  private mime = new Map<string, string>();
  private readonly admission = new PolicyGate(4, 128);
  private sequence = 0;
  private total = 0;
  private request: BackendOpen;
  constructor(request: BackendOpen) {
    this.request = request;
  }
  list(): BrowserDownload[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
  /** Quarantined copies of finished downloads, by download id. */
  private sources = new Map<string, DownloadSource>();
  /**
   * A finished download's quarantined copy, which only this session wrote (never the copy in
   * the person's downloads folder, which anyone may have changed since).
   */
  source(downloadId: string): DownloadSource | undefined {
    const source = this.sources.get(downloadId);
    return source ? { ...source } : undefined;
  }
  async allowed(url: string): Promise<boolean> {
    if (this.privateMode) return false;
    if (this.entries.length > 128) return false;
    const generation = this.privacyGeneration;
    const allowed =
      (await this.request.allowed(url)) && (await this.request.downloadAllowed?.(url)) === true;
    this.request.signal.throwIfAborted();
    if (this.privateMode || generation !== this.privacyGeneration) return false;
    return allowed;
  }
  response(url: string, mime: string): void {
    if (this.mime.size >= 256) this.mime.delete(this.mime.keys().next().value ?? "");
    this.mime.set(url, mime.split(";")[0]?.slice(0, 256) || "application/octet-stream");
  }
  /**
   * `folder`: the downloads folder for this engine (the person's choice, else the machine's
   * Downloads folder). The quarantined copy stays with the thread's browser session as the
   * thread's artifact; the finished file is also saved in `folder` under its own name (numbered
   * when taken), and the download lists that real path. Without a folder, or if it can't be
   * written, the download lists the session copy.
   */
  async accept(download: Download, tabId: string, folder?: string): Promise<void> {
    const directory = this.request.downloadDir;
    if (this.privateMode || this.entries.length >= 128 || !directory) {
      await download.cancel().catch(() => {});
      await download.delete().catch(() => {});
      return;
    }
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
    const path = join(directory, `${entry.downloadId}-${filename}`);
    let published = false;
    try {
      await this.admission.run(
        signal,
        async () => {
          try {
            if (!(await this.allowed(download.url()))) {
              entry.state = "denied";
              await download.cancel();
              return;
            }
            signal.throwIfAborted();
            await mkdir(directory, { recursive: true, mode: 0o700 });
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
            if (this.request.artifact) {
              await this.request.artifact({
                path,
                mimeType,
                bytes: entry.bytes,
                filename,
                flags: entry.flags,
              });
              published = true;
            }
            signal.throwIfAborted();
            const saved = folder
              ? await saveInFolder(path, folder, filename).catch(() => undefined)
              : undefined;
            entry.state = "complete";
            entry.path = saved ?? path;
            this.sources.set(entry.downloadId, {
              path,
              bytes: entry.bytes,
              filename,
              mimeType,
              flags: entry.flags,
            });
          } finally {
            // PolicyGate can return on cancellation before this work settles.
            // The publisher owns these bytes until it acknowledges or rejects.
            // Successful publication retains its original path even if cancelled.
            if (!published && entry.state !== "complete") await rm(path, { force: true });
          }
        },
        600_000,
      );
    } catch {
      if (entry.state === "pending") entry.state = abort.signal.aborted ? "denied" : "failed";
      // A gate deadline must also stop streaming and fence any late completion.
      abort.abort();
      await download.cancel().catch(() => {});
    } finally {
      this.transfers.delete(abort);
      this.request.changed?.();
      // Chromium's transient GUID file must not double the quarantine budget.
      await download.delete().catch(() => {});
    }
  }
}
