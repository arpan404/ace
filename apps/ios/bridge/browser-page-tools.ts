import { BrowserFeaturesClient, fetchBrowserDownload, type ClientCore } from "@ace/client";
import {
  BrowserArtifact,
  BrowserScreenshotSet,
  BrowserScreenshotSize,
  ThreadId,
  type BrowserCommand,
  type BrowserState,
} from "@ace/protocol";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { base64 } from "./bytes.ts";
import { reason } from "./browser-tools.ts";
import { phoneDownloadMax } from "./browser-view.ts";

/*
 * The page's own commands from the phone's browser menu, beside the address and tab tools in
 * `browser-tools.ts`: mute a tab, record the page, clear browsing data, read the page source,
 * print to a PDF kept with the thread, screenshot at several sizes, list the engine's
 * extensions, and save a download onto the phone. Each is one request, never replayed after a
 * reconnect; a failure comes back as one sentence (`browser:problem`), a finished one as one
 * sentence the screen shows briefly (`browser:done`).
 */

const tabId = z.string().min(1).max(256);
export const BrowserPageAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mute"), tabId, muted: z.boolean() }),
  z.object({ kind: z.literal("record"), on: z.boolean() }),
  z.object({ kind: z.literal("clearData") }),
  /** The page source sheet: open reads the shown tab's source; closed forgets it. */
  z.object({ kind: z.literal("source"), open: z.boolean() }),
  z.object({ kind: z.literal("print") }),
  z.object({ kind: z.literal("sizes"), sizes: z.array(BrowserScreenshotSize).min(1).max(3) }),
  z.object({ kind: z.literal("extensions") }),
  /** Copy a finished download onto the phone; `cancel` stops one on its way. */
  z.object({ kind: z.literal("save"), downloadId: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("saveCancel"), downloadId: z.string().min(1).max(256) }),
]);
export type BrowserPageAction = z.infer<typeof BrowserPageAction>;

const Source = z.object({ url: z.string(), source: z.string(), truncated: z.boolean() });
const Extensions = z.object({
  extensions: z
    .array(
      z.object({
        id: z.string().max(256),
        name: z.string().max(256),
        version: z.string().max(64).optional(),
        enabled: z.boolean(),
      }),
    )
    .max(256),
});

/** The page source the sheet shows, in UTF-16 units; the daemon bounds what it sends too. */
const sourceLimit = 512 * 1024;

/** Where a saved download's bytes go on the phone (`Sources/Bridge/SavedFiles`). */
export interface PhoneFiles {
  /** Appends base64 bytes at `offset` to the phone's copy of `id`; `done` closes it. */
  write(
    input: { id: string; name: string; offset: number; done: boolean },
    body: string,
  ): Promise<unknown>;
  /** Deletes the phone's copy of `id`, whole or partial. */
  discard(input: { id: string; name: string }): Promise<unknown>;
}

export interface PageToolsHost {
  owner: Pick<ClientCore, "request"> & Partial<Pick<ClientCore, "onStream">>;
  sink: PatchSink;
  preview: Preview;
  now(): number;
  files: PhoneFiles;
  current(): { threadId: ThreadId; state: BrowserState | undefined } | undefined;
}

interface Saving {
  threadId: string;
  name: string;
  abort: AbortController;
}

export class BrowserPageTools {
  #host: PageToolsHost;
  #features: BrowserFeaturesClient;
  /** Threads whose page this phone started recording (the daemon says only that one runs). */
  #recording = new Set<string>();
  #saving = new Map<string, Saving>();
  constructor(host: PageToolsHost) {
    this.#host = host;
    this.#features = new BrowserFeaturesClient(host.owner);
  }
  /** Whether this phone started the recording that runs on `threadId`'s page. */
  recordingHere(threadId: string): boolean {
    return this.#recording.has(threadId);
  }
  /** The view closed: one-shot answers go; saves on their way finish on their own. */
  close(): void {
    for (const key of ["browser:source", "browser:sizes", "browser:extensions"])
      this.#host.sink.clear(key);
  }
  /** The recording ended elsewhere (another screen, the browser closed): forget it here. */
  observe(state: BrowserState): void {
    if (!state.recording) this.#recording.delete(state.threadId);
  }
  handle(action: BrowserPageAction): void {
    const current = this.#host.current();
    if (!current) return;
    const { threadId, state } = current;
    const shownId = state?.closed ? undefined : state?.activeTabId;
    switch (action.kind) {
      case "mute":
        this.#ask(
          action.muted ? "Couldn't mute the tab" : "Couldn't unmute the tab",
          this.#features.muteTab(threadId, action.tabId, action.muted),
        );
        return;
      case "record":
        void this.#record(threadId, action.on);
        return;
      case "clearData":
        void this.#run("Couldn't clear browsing data", { action: "clear_data" }, shownId).then(
          (done) => done !== undefined && this.#done("Browsing data cleared"),
        );
        return;
      case "source":
        if (!action.open) return this.#host.sink.clear("browser:source");
        void this.#source(shownId);
        return;
      case "print":
        void this.#print(shownId);
        return;
      case "sizes":
        void this.#sizes(action.sizes, shownId);
        return;
      case "extensions":
        void this.#extensions();
        return;
      case "save":
        void this.#save(threadId, action.downloadId, state);
        return;
      case "saveCancel":
        this.#saving.get(savingKey(threadId, action.downloadId))?.abort.abort();
        return;
    }
  }

  async #record(threadId: ThreadId, on: boolean): Promise<void> {
    if (on) {
      const started = await this.#request("Couldn't start recording", {
        type: "browser.recording.start",
        threadId,
      });
      if (started === undefined) return;
      this.#recording.add(threadId);
      this.#done("Recording the page");
      return;
    }
    const stopped = await this.#request("Couldn't stop recording", {
      type: "browser.recording.stop",
      threadId,
    });
    this.#recording.delete(threadId);
    if (stopped === undefined) return;
    const artifact = BrowserArtifact.safeParse(stopped);
    this.#done(
      "Recording saved to this thread",
      artifact.success ? (artifact.data.filename ?? fileName(artifact.data.path)) : undefined,
    );
  }
  async #source(shownId: string | undefined): Promise<void> {
    const raw = await this.#run(
      "Couldn't read the page source",
      { action: "page_source" },
      shownId,
    );
    const source = Source.safeParse(raw);
    if (!source.success) return;
    const text = source.data.source;
    const cut = text.length > sourceLimit;
    this.#host.sink.put("browser:source", () => ({
      type: "browser.source",
      url: this.#host.preview(source.data.url, 2048),
      source: cut ? text.slice(0, sourceLimit) : text,
      truncated: source.data.truncated || cut,
    }));
  }
  async #print(shownId: string | undefined): Promise<void> {
    const raw = await this.#run(
      "Couldn't print the page",
      { action: "pdf", landscape: false, printBackground: true },
      shownId,
      60_000,
    );
    const saved = z.object({ path: z.string() }).safeParse(raw);
    if (saved.success) this.#done("PDF saved to this thread", fileName(saved.data.path));
  }
  async #sizes(
    sizes: readonly z.infer<typeof BrowserScreenshotSize>[],
    shownId: string | undefined,
  ): Promise<void> {
    const at = this.#host.now();
    this.#host.sink.put("browser:sizes", () => ({ type: "browser.sizes", at, images: null }));
    const raw = await this.#run(
      "Couldn't take the screenshots",
      { action: "screenshot", fullPage: false, sizes: [...sizes] },
      shownId,
      120_000,
    );
    const set = BrowserScreenshotSet.safeParse(raw);
    if (!set.success) {
      // None taken: the sheet stops waiting (the problem says why).
      this.#host.sink.put("browser:sizes", () => ({ type: "browser.sizes", at, images: [] }));
      return;
    }
    this.#host.sink.put("browser:sizes", () => ({
      type: "browser.sizes",
      at,
      images: set.data.images.map((image) => ({
        size: image.size,
        width: image.width,
        height: image.height,
        data: image.data,
      })),
    }));
  }
  async #extensions(): Promise<void> {
    this.#host.sink.put("browser:extensions", () => ({ type: "browser.extensions", items: null }));
    const raw = await this.#run("Couldn't list the extensions", {
      action: "extensions",
      operation: "list",
    });
    const listed = Extensions.safeParse(raw ?? { extensions: [] });
    const items = listed.success ? listed.data.extensions : [];
    const preview = this.#host.preview;
    this.#host.sink.put("browser:extensions", () => ({
      type: "browser.extensions",
      items: items.map((item) => ({
        id: item.id,
        name: preview(item.name, 128),
        version: item.version ?? null,
        enabled: item.enabled,
      })),
    }));
  }
  /**
   * A finished download, copied over the connection and written to the phone a slice at a time;
   * its progress and outcome go to Swift as `browser.saving`, which offers the file once ready.
   */
  async #save(
    threadId: ThreadId,
    downloadId: string,
    state: BrowserState | undefined,
  ): Promise<void> {
    // A download id is the thread's own: the same id in another thread is another file.
    const key = savingKey(threadId, downloadId);
    if (this.#saving.has(key)) return;
    const download = state?.downloads?.find((each) => each.downloadId === downloadId);
    if (!download || download.state !== "complete") {
      this.#problem("That download hasn't finished on your computer yet.");
      return;
    }
    if (download.bytes > phoneDownloadMax) {
      this.#problem(`Files over ${phoneDownloadMax / (1024 * 1024)} MB stay on your computer.`);
      return;
    }
    const name = download.filename;
    const saving: Saving = { threadId, name, abort: new AbortController() };
    this.#saving.set(key, saving);
    const id = `${threadId}/${downloadId}`;
    const put = (phase: "saving" | "ready" | "failed", progress: number, message?: string) =>
      this.#host.sink.put(`browser:saving:${key}`, () => ({
        type: "browser.saving",
        threadId,
        downloadId,
        name: this.#host.preview(name, 256),
        phase,
        progress,
        message: message ?? null,
      }));
    put("saving", 0);
    try {
      // Each verified chunk goes straight to the phone's file: one chunk is held at a time.
      await fetchBrowserDownload(this.#host.owner, threadId, downloadId, {
        signal: saving.abort.signal,
        limit: phoneDownloadMax,
        onProgress: (received, size) => put("saving", size > 0 ? received / size : 0),
        onChunk: async (chunk) => {
          saving.abort.signal.throwIfAborted();
          await this.#host.files.write(
            { id, name, offset: chunk.offset, done: chunk.done },
            base64(chunk.bytes),
          );
        },
      });
      put("ready", 1);
    } catch (error) {
      // What arrived of it goes: a partial file is never offered.
      void this.#host.files.discard({ id, name }).catch(() => {});
      if (saving.abort.signal.aborted) this.#host.sink.clear(`browser:saving:${key}`);
      else put("failed", 0, `Couldn't save ${name} to this phone. ${reason(error)}`);
    } finally {
      this.#saving.delete(key);
    }
  }
  /** A person's command to the shown tab; its failure becomes one sentence. */
  async #run(
    title: string,
    command: BrowserCommand,
    tab?: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    const current = this.#host.current();
    if (!current) return undefined;
    return this.#request(
      title,
      {
        type: "browser.execute",
        threadId: current.threadId,
        command: tab ? { ...command, tabId: tab } : command,
      },
      timeoutMs,
    );
  }
  async #request(
    title: string,
    request:
      | { type: "browser.execute"; threadId: ThreadId; command: BrowserCommand }
      | { type: "browser.recording.start" | "browser.recording.stop"; threadId: ThreadId },
    timeoutMs?: number,
  ): Promise<unknown> {
    try {
      const reply = await this.#host.owner.request(request, timeoutMs ? { timeoutMs } : {});
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
      return reply.result ?? null;
    } catch (error) {
      this.#problem(`${title}. ${reason(error)}`);
      return undefined;
    }
  }
  #ask(title: string, request: Promise<unknown>): void {
    request.catch((error: unknown) => this.#problem(`${title}. ${reason(error)}`));
  }
  #done(message: string, detail?: string): void {
    const at = this.#host.now();
    const preview = this.#host.preview;
    this.#host.sink.put("browser:done", () => ({
      type: "browser.done",
      at,
      message: preview(message, 256),
      detail: detail ? preview(detail, 256) : null,
    }));
  }
  #problem(message: string): void {
    const at = this.#host.now();
    const text = this.#host.preview(message, 512);
    this.#host.sink.put("browser:problem", () => ({ type: "browser.problem", at, message: text }));
  }
}

const savingKey = (threadId: string, downloadId: string) => `${threadId}:${downloadId}`;
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
