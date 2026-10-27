import type { ForgePrStatus, GitStatusFile } from "@ace/protocol";
import {
  collectTurns,
  editedTurns,
  groupFileChanges,
  resolveScope,
  scopeEdits,
  scopeLabel,
  type DiffScope,
  type FileChanges,
  type ResolvedScope,
  type Turn,
  type TurnReader,
} from "@ace/ui-core";
import { workingVersion, type ScopeFile, type Sourced, type TurnDiffs } from "./changes-diffs.ts";

/*
 * Which changes the sheet lists: the checkout's uncommitted files (the daemon's reads), or the
 * edits of the last turn, one turn or every turn in the loaded history, by the web's scope
 * rules. Turns are collected again only after an edit, a run or the history changed.
 */

/** What the daemon's `git.status`, `git.diff` and `pr.status` reads answered. */
export interface Reads {
  files: readonly GitStatusFile[];
  /** The same files by path. */
  byPath: ReadonlyMap<string, GitStatusFile>;
  truncated: boolean;
  head: string | null | undefined;
  sections: Map<string, string>;
  /** The daemon cut the patch at its cap: the last file's section may be incomplete. */
  patchTruncated: boolean;
  lastPath: string | undefined;
  pr: ForgePrStatus | null;
  /** Counts the reads, so a file cut from this one knows which read it was listed in. */
  round: number;
  /**
   * The versions (daemon validators) of files cut from the patch, as learned by reading their
   * first page since this read; a cut file's version is unknown until then.
   */
  validators: Map<string, string>;
}

export interface ScopeOption {
  id: DiffScope;
  label: string;
  /** The turn's number for a turn's scope. */
  turn: number | null;
}

export class ChangesScope {
  #reader: TurnReader;
  #diffs: TurnDiffs;
  #requested: DiffScope = "last";
  #turns: Turn[] = [];
  #dirty = true;
  #edits: { resolved: ResolvedScope; files: FileChanges[] } | undefined;
  #versions = new WeakMap<Reads, Map<string, string>>();

  constructor(reader: TurnReader, diffs: TurnDiffs) {
    this.#reader = reader;
    this.#diffs = diffs;
  }

  /** The thread's edits may have changed. */
  invalidate(): void {
    this.#dirty = true;
    this.#edits = undefined;
  }

  request(scope: DiffScope): void {
    this.#requested = scope;
    this.#edits = undefined;
  }

  #edited(): Turn[] {
    if (this.#dirty) {
      this.#turns = editedTurns(collectTurns(this.#reader));
      this.#dirty = false;
    }
    return this.#turns;
  }

  #scoped(): { resolved: ResolvedScope; files: FileChanges[] } {
    const edited = this.#edited();
    if (this.#edits) return this.#edits;
    const resolved = resolveScope(this.#requested, edited);
    this.#edits = { resolved, files: groupFileChanges(scopeEdits(resolved, edited)) };
    return this.#edits;
  }

  get resolved(): ResolvedScope {
    return this.#scoped().resolved;
  }
  get workingTree(): boolean {
    return this.resolved.scope === "working-tree";
  }

  /** The scopes the phone's menu offers: turns only once a turn edited files. */
  options(): ScopeOption[] {
    const edited = this.#edited();
    const tree: ScopeOption = { id: "working-tree", label: "Uncommitted", turn: null };
    if (!edited.length) return [tree];
    return [
      tree,
      { id: "last", label: scopeLabel("last", edited), turn: null },
      { id: "all", label: scopeLabel("all", edited), turn: null },
      ...edited.map((turn) => ({
        id: turn.id,
        label: scopeLabel(turn.id, edited),
        turn: turn.number,
      })),
    ];
  }

  label(): string {
    return scopeLabel(this.resolved.scope, this.#edited());
  }

  /** A turn scope's files, in first-touched order. */
  turnFiles(): ScopeFile[] {
    return this.#scoped().files.map((file) => this.#diffs.row(file));
  }

  /** Where `path`'s diff comes from in this scope, and its version; undefined if not listed. */
  sourceOf(path: string, reads: Reads | undefined): Sourced | undefined {
    if (!this.workingTree) {
      const file = this.#scoped().files.find((candidate) => candidate.path === path);
      return file && { source: { kind: "turn", file }, version: this.#diffs.key(file) };
    }
    const file = reads?.byPath.get(path);
    if (!reads || !file) return undefined;
    const version = this.versionOf(path, reads) ?? "";
    if (file.binary) return { source: { kind: "binary" }, version };
    const section = reads.sections.get(path);
    if (cutIn(reads, path))
      return {
        source: { kind: "daemon", path, from: file.from ?? null, round: reads.round },
        version,
      };
    return { source: { kind: "section", text: section ?? "" }, version };
  }

  /** The version a viewed mark is checked against; undefined while a cut file's is unknown. */
  versionOf(path: string, reads: Reads | undefined): string | undefined {
    if (!this.workingTree) {
      const file = this.#scoped().files.find((candidate) => candidate.path === path);
      return file && this.#diffs.key(file);
    }
    if (!reads) return undefined;
    if (cutIn(reads, path)) return reads.validators.get(path);
    let versions = this.#versions.get(reads);
    if (!versions) this.#versions.set(reads, (versions = new Map()));
    const held = versions.get(path);
    if (held !== undefined) return held;
    const file = reads.byPath.get(path);
    if (!file) return undefined;
    const version = workingVersion(reads.sections.get(path) ?? "");
    versions.set(path, version);
    return version;
  }
}

/** A file missing from a cut patch, or the file the cut fell in, may be incomplete. */
export function cutIn(reads: Reads, path: string): boolean {
  return reads.patchTruncated && (!reads.sections.has(path) || reads.lastPath === path);
}
