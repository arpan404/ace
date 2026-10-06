import { randomUUID } from "node:crypto";
import { z } from "zod";
import { join } from "node:path";
import type { DownloadItem } from "electron";
/** Paused native downloads are resumed only after the daemon's consent gate. */
export class NativeDownloads {
  private items = new Map<string, DownloadItem>();
  private directory: string | undefined;
  private emit: (method: string, params: unknown) => void;
  constructor(directory: string | undefined, emit: (method: string, params: unknown) => void) {
    this.directory = directory;
    this.emit = emit;
  }
  accept(item: DownloadItem): boolean {
    if (!this.directory || this.items.size >= 4) return false;
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
      if (method === "ace.download.resume") item.resume();
      else item.cancel();
    }
    return true;
  }
  close() {
    for (const item of this.items.values()) item.cancel();
    this.items.clear();
  }
}
