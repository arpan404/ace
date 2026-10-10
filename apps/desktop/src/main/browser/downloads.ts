import { randomUUID } from "node:crypto";
import { z } from "zod";
import { join } from "node:path";
export interface NativeDownload {
  setSavePath(path: string): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  getReceivedBytes(): number;
  getURL(): string;
  getFilename(): string;
  getMimeType(): string;
  on(event: "updated", listener: () => void): unknown;
  once(event: "done", listener: (event: unknown, state: string) => void): unknown;
}
/** Paused native downloads are resumed only after the daemon's consent gate. */
export class NativeDownloads {
  private items = new Map<string, NativeDownload>();
  private running = new Set<string>();
  private ready: string[] = [];
  private directory: string | undefined;
  private emit: (method: string, params: unknown) => void;
  constructor(directory: string | undefined, emit: (method: string, params: unknown) => void) {
    this.directory = directory;
    this.emit = emit;
  }
  accept(item: NativeDownload): boolean {
    if (!this.directory || this.items.size >= 128) return false;
    const guid = `native-${randomUUID()}`;
    item.setSavePath(join(this.directory, guid));
    item.pause();
    this.items.set(guid, item);
    item.on("updated", () =>
      this.emit("ace.download.progress", {
        guid,
        bytes: item.getReceivedBytes(),
        state: "pending",
      }),
    );
    item.once("done", (_event, state) => {
      this.items.delete(guid);
      this.running.delete(guid);
      this.ready = this.ready.filter((id) => id !== guid);
      this.drain();
      this.emit("ace.download.progress", { guid, bytes: item.getReceivedBytes(), state });
    });
    this.emit("ace.download.started", {
      guid,
      url: item.getURL().slice(0, 8192),
      filename: item.getFilename().slice(0, 256),
      mimeType: item.getMimeType().slice(0, 256),
    });
    return true;
  }
  command(method: string, params: unknown): boolean {
    if (method !== "ace.download.resume" && method !== "ace.download.cancel") return false;
    const { guid } = z.object({ guid: z.string().regex(/^native-[a-f0-9-]{36}$/) }).parse(params);
    const item = this.items.get(guid);
    if (item) {
      if (method === "ace.download.resume") {
        if (!this.running.has(guid) && !this.ready.includes(guid)) this.ready.push(guid);
        this.drain();
      } else item.cancel();
    }
    return true;
  }
  private drain(): void {
    while (this.running.size < 4 && this.ready.length) {
      const id = this.ready.shift();
      if (!id) continue;
      const item = this.items.get(id);
      if (!item) continue;
      this.running.add(id);
      item.resume();
    }
  }
  close() {
    this.ready = [];
    for (const item of this.items.values()) item.cancel();
    this.items.clear();
  }
}
