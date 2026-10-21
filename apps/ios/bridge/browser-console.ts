import type { BrowserCommand } from "@ace/protocol";
import {
  consoleLevel,
  entryKeys,
  formatRequestBytes,
  formatRequestDuration,
  readBrowserLogs,
  requestFailed,
  visibleEntries,
  type BrowserLogEntry,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import type { Schedule } from "./browser-live.ts";

/*
 * The console sheet: the shown tab's console messages or network requests (the log agents read
 * with `browser_logs`), read again each second while the sheet is open, filtered as the web's
 * console drawer filters them. Clear hides what is listed now; agents keep their log.
 */

export const ConsoleFilter = z.object({
  section: z.enum(["console", "network"]),
  level: z.enum(["all", "error", "warning", "info"]),
  requests: z.enum(["all", "failed"]),
});
export type ConsoleFilter = z.infer<typeof ConsoleFilter>;

const pollMs = 1000;
const shownLimit = 200;

interface ConsoleHost {
  sink: PatchSink;
  preview: Preview;
  schedule: Schedule;
  current(): { state?: { activeTabId?: string | undefined } | undefined } | undefined;
}

export class BrowserConsole {
  #host: ConsoleHost;
  #execute: (command: BrowserCommand) => Promise<unknown>;
  #filter: ConsoleFilter | undefined;
  #entries: readonly BrowserLogEntry[] = [];
  /** Where the person last pressed Clear, per tab and section. */
  #cleared = new Map<string, number>();
  #timer: (() => void) | undefined;
  #reads = 0;
  constructor(host: ConsoleHost, execute: (command: BrowserCommand) => Promise<unknown>) {
    this.#host = host;
    this.#execute = execute;
  }
  open(filter: ConsoleFilter, clear: boolean, tabId: string | undefined): void {
    this.#filter = filter;
    if (clear && tabId) {
      const newest = this.#entries.findLast((entry) => entry.kind === filter.section)?.at;
      if (newest !== undefined) this.#cleared.set(`${tabId}\u0000${filter.section}`, newest);
    }
    this.#put(tabId);
    this.#read();
  }
  close(): void {
    this.#filter = undefined;
    this.#entries = [];
    this.#reads++;
    this.#timer?.();
    this.#timer = undefined;
    this.#host.sink.clear("browser:logs");
  }
  #read(): void {
    this.#timer?.();
    this.#timer = undefined;
    const tabId = this.#host.current()?.state?.activeTabId;
    if (!this.#filter || !tabId) return;
    const read = ++this.#reads;
    void this.#execute({ action: "logs", tabId, limit: shownLimit })
      .then((result) => {
        if (read !== this.#reads) return;
        this.#entries = readBrowserLogs(result);
        this.#put(tabId);
      })
      .catch(() => {})
      .finally(() => {
        if (read !== this.#reads || !this.#filter) return;
        this.#timer = this.#host.schedule(pollMs, () => this.#read());
      });
  }
  #put(tabId: string | undefined): void {
    const filter = this.#filter;
    if (!filter) return;
    const preview = this.#host.preview;
    const clearedAt = tabId ? this.#cleared.get(`${tabId}\u0000${filter.section}`) : undefined;
    const shown =
      filter.section === "console"
        ? visibleEntries(this.#entries, { kind: "console", level: filter.level, clearedAt })
        : visibleEntries(this.#entries, { kind: "network", filter: filter.requests, clearedAt });
    const keys = entryKeys(shown);
    this.#host.sink.put("browser:logs", () => ({
      type: "browser.logs",
      section: filter.section,
      entries: shown.slice(-shownLimit).map((entry, index) => ({
        key: keys[index] ?? String(index),
        level: entry.kind === "console" ? consoleLevel(entry.type) : null,
        text: preview(entry.text, 2048),
        url: entry.url ? preview(entry.url, 1024) : null,
        status:
          entry.type === "failed"
            ? "Failed"
            : entry.status !== undefined
              ? String(entry.status)
              : "",
        method: entry.method ?? "",
        size: formatRequestBytes(entry.bytes),
        time: formatRequestDuration(entry.durationMs),
        failed: entry.kind === "network" && requestFailed(entry),
      })),
    }));
  }
}
