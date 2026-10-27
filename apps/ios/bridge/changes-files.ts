import type { DiffRow } from "@ace/ui-core";
import type { DiffRows } from "@ace/ui-core/review";
import {
  mobilePageLimits,
  pageEnd,
  splitPage,
  unifiedPage,
  wholeLine,
  type PageLimits,
} from "@ace/ui-core/mobile";
import type { PatchSink, Preview } from "./agents.ts";
import type { DiffLayout } from "./changes-kept.ts";
import { sectionDiff, type FileSource, type Sourced, type TurnDiffs } from "./changes-diffs.ts";

/*
 * The files open in the Changes sheet, several at once. Each open file ships a small header
 * patch and its rows in pages (`changes:page:<id>:<n>`); asking for more sends the next page
 * only, so a long file costs what has been read of it. A file cut from the checkout's patch is
 * read alone from the daemon, one 256 KiB page at a time, as far as the pages asked for reach.
 */

export interface OpenFilesLimits extends PageLimits {
  /** Files open at once; expand-all opens this many. */
  open: number;
  /** Code units of a whole line asked for on its own. */
  wholeLine: number;
  /** Code units of one file's patch held from the daemon's pages. */
  heldText: number;
}
export const openFilesLimits: OpenFilesLimits = {
  ...mobilePageLimits,
  open: 30,
  wholeLine: 100_000,
  heldText: 16 * 1024 * 1024,
};

/** One page of one file's patch from the daemon (`git.diff` with `path`). */
export type ReadPage = (
  path: string,
  from: string | null,
  offset: number,
) => Promise<{ patch: string; truncated: boolean; nextOffset?: number | undefined }>;

interface Open {
  id: string;
  path: string;
  version: string;
  source: FileSource;
  state: "loading" | "ready" | "error";
  message: string;
  rows: readonly DiffRow[];
  complete: boolean;
  /** The daemon's pages stopped before the file's end (past what the bridge holds). */
  cut: boolean;
  /** Where each page sent so far ends. */
  ends: number[];
  /** Pages asked for. */
  wanted: number;
  /** Text read from the daemon and where its next page starts. */
  text: string;
  next: number | undefined;
  reading: boolean;
  /** Bumped when the file's version changes, so a late read is dropped. */
  generation: number;
}

export interface OpenFilesDeps {
  sink: PatchSink;
  preview: Preview;
  threadId: string;
  epoch: number;
  diffs: TurnDiffs;
  readPage: ReadPage;
  layout: () => DiffLayout;
  viewed: (path: string, version: string) => boolean;
  limits?: OpenFilesLimits;
}

export class OpenFiles {
  #deps: OpenFilesDeps;
  #limits: OpenFilesLimits;
  #open = new Map<string, Open>();
  #ids = new Map<string, string>();
  #count = 0;

  constructor(deps: OpenFilesDeps) {
    this.#deps = deps;
    this.#limits = deps.limits ?? openFilesLimits;
  }

  get paths(): string[] {
    return [...this.#open.keys()];
  }
  get limit(): number {
    return this.#limits.open;
  }

  /** Open `path` from `sourced`; false past the limit of open files. */
  open(path: string, sourced: Sourced | undefined): boolean {
    if (this.#open.has(path)) return true;
    if (this.#open.size >= this.#limits.open) return false;
    // Fixed width, so clearing one file's keys by prefix never reaches another's.
    const id = this.#ids.get(path) ?? `f${(++this.#count).toString(36).padStart(5, "0")}`;
    this.#ids.set(path, id);
    const file = this.#fresh(id, path, sourced);
    this.#open.set(path, file);
    this.#load(file);
    return true;
  }

  close(path: string): void {
    const file = this.#open.get(path);
    if (!file) return;
    this.#open.delete(path);
    file.generation++;
    this.#clear(file.id);
  }

  closeAll(): void {
    for (const path of [...this.#open.keys()]) this.close(path);
  }

  /** Follow new reads or a new scope: a file whose version changed starts again at page one. */
  sync(sourceOf: (path: string) => Sourced | undefined): void {
    for (const [path, file] of this.#open) {
      const sourced = sourceOf(path);
      if (sourced && sourced.version === file.version) {
        this.#header(file);
        continue;
      }
      this.#clear(file.id);
      const fresh = this.#fresh(file.id, path, sourced);
      fresh.generation = file.generation + 1;
      this.#open.set(path, fresh);
      this.#load(fresh);
    }
  }

  /** The layout changed: every sent page goes again in it. */
  relayout(): void {
    for (const file of this.#open.values()) this.#emit(file);
  }

  /** Viewed marks changed: headers carry them. */
  headers(): void {
    for (const file of this.#open.values()) this.#header(file);
  }

  /** One more page of `path`, read from the daemon first when it isn't held yet. */
  more(path: string): boolean {
    const file = this.#open.get(path);
    if (!file) return false;
    file.wanted++;
    this.#emit(file);
    return true;
  }

  /** One line whole (up to `wholeLine` code units), for a line a page clipped. */
  line(path: string, index: number): boolean {
    const file = this.#open.get(path);
    const row = file && wholeLine(file.rows, index, this.#limits.wholeLine, this.#deps.preview);
    if (!file || !row) return false;
    this.#deps.sink.put("changes:line", () => ({
      type: "changes.line",
      threadId: this.#deps.threadId,
      epoch: this.#deps.epoch,
      file: file.id,
      path: this.#deps.preview(file.path, 1024),
      version: file.version,
      row,
    }));
    return true;
  }

  /** The rows an open file's diff has so far, for a comment's selection. */
  diffOf(path: string): DiffRows | undefined {
    const file = this.#open.get(path);
    return file?.state === "ready" ? { rows: file.rows } : undefined;
  }

  versionOf(path: string): string | undefined {
    return this.#open.get(path)?.version;
  }

  #fresh(id: string, path: string, sourced: Sourced | undefined): Open {
    return {
      id,
      path,
      version: sourced?.version ?? "",
      source: sourced?.source ?? { kind: "binary" },
      state: sourced ? "loading" : "error",
      message: sourced ? "" : "not_in_scope",
      rows: [],
      complete: false,
      cut: false,
      ends: [],
      wanted: 1,
      text: "",
      next: 0,
      reading: false,
      generation: 0,
    };
  }

  #load(file: Open): void {
    const { source } = file;
    if (file.state === "error") return this.#header(file);
    if (source.kind === "daemon") return this.#emit(file);
    file.rows =
      source.kind === "turn"
        ? this.#deps.diffs.diff(source.file).rows
        : source.kind === "section"
          ? (sectionDiff(source.text)?.rows ?? [])
          : [];
    file.complete = true;
    file.state = "ready";
    this.#emit(file);
  }

  /** Send the header and every page asked for that is known; read on when one isn't. */
  #emit(file: Open): void {
    const limits = this.#limits;
    while (file.ends.length < file.wanted) {
      const start = file.ends.at(-1) ?? 0;
      if (start >= file.rows.length && file.complete) break;
      const end = pageEnd(file.rows, start, file.complete, limits);
      if (end === undefined) break;
      file.ends.push(end);
    }
    if (file.ends.length < file.wanted && !file.complete) this.#read(file);
    this.#header(file);
    file.ends.forEach((end, index) => this.#page(file, index, file.ends[index - 1] ?? 0, end));
  }

  #page(file: Open, index: number, start: number, end: number): void {
    const { sink, preview, threadId, epoch, layout } = this.#deps;
    const generation = file.generation;
    sink.put(`changes:page:${file.id}:${index}`, () => {
      if (this.#open.get(file.path) !== file || file.generation !== generation) return undefined;
      const split = layout() === "split";
      return {
        type: "changes.page",
        threadId,
        epoch,
        file: file.id,
        path: preview(file.path, 1024),
        version: file.version,
        index,
        layout: split ? "split" : "unified",
        ...(split
          ? { pairs: splitPage(file.rows, start, end, this.#limits, preview) }
          : { lines: unifiedPage(file.rows, start, end, this.#limits, preview) }),
      };
    });
  }

  #header(file: Open): void {
    const { sink, preview, threadId, epoch, viewed } = this.#deps;
    sink.put(`changes:file:${file.id}`, () => {
      if (this.#open.get(file.path) !== file) return undefined;
      const sent = file.ends.at(-1) ?? 0;
      return {
        type: "changes.file",
        threadId,
        epoch,
        file: file.id,
        path: preview(file.path, 1024),
        version: file.version,
        state: file.state,
        message: file.message,
        binary: file.source.kind === "binary",
        pages: file.ends.length,
        rows: file.rows.length,
        remaining: file.complete ? Math.max(0, file.rows.length - sent) : null,
        complete: file.complete,
        cut: file.cut,
        empty: file.complete && !file.rows.some((row) => row.kind !== "fold"),
        viewed: viewed(file.path, file.version),
      };
    });
  }

  #read(file: Open): void {
    const { source } = file;
    if (file.reading || source.kind !== "daemon" || file.next === undefined) return;
    file.reading = true;
    const generation = file.generation;
    const live = () => this.#open.get(file.path) === file && file.generation === generation;
    this.#deps
      .readPage(source.path, source.from, file.next)
      .then((page) => {
        if (!live()) return;
        file.text += page.patch;
        file.next = page.truncated ? page.nextOffset : undefined;
        if (file.text.length >= this.#limits.heldText && file.next !== undefined) {
          file.next = undefined;
          file.cut = true;
        }
        if (page.truncated && page.nextOffset === undefined) file.cut = true;
        file.complete = file.next === undefined;
        file.rows = sectionDiff(file.text)?.rows ?? [];
        file.state = "ready";
      })
      .catch((error: unknown) => {
        if (!live()) return;
        file.state = "error";
        file.message = error instanceof Error && error.message ? error.message : "unavailable";
      })
      .finally(() => {
        if (!live()) return;
        file.reading = false;
        if (file.state !== "error") this.#emit(file);
        else this.#header(file);
      });
  }

  #clear(id: string): void {
    this.#deps.sink.clear(`changes:file:${id}`);
    this.#deps.sink.clear(`changes:page:${id}:`);
  }
}
