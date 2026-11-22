import { useClient } from "@ace/client-react";
import { CheckIcon, CopyIcon, GitCommitIcon } from "@ace/icons";
import type { GitBlameCommit } from "@ace/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { HoverCardContent } from "@/components/ui/hover-card-content.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  onBufferEdits,
  useStatusReport,
  type StatusStore,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { SharedWork } from "@ace/core/shared-work";
import { readGitBlame, type CommitDiffTarget } from "@/lib/git-history.ts";
import {
  blameChunkSize,
  committedLineAt,
  committedRange,
  missingBlameChunks,
  resolveCaretBlame,
  type BlameAttribution,
  type BlameRangeChunk,
} from "./inline-blame.ts";
import type { GutterState } from "./live-gutter.ts";

export interface EditorBlameHost {
  statusStore: StatusStore;
  openCommitDiff(target: CommitDiffTarget): void;
}

export const EditorBlameHostContext = createContext<EditorBlameHost | undefined>(undefined);

export function useEditorBlameHost(): EditorBlameHost | undefined {
  return useContext(EditorBlameHostContext);
}

interface BlameFileCache {
  commits: Map<string, GitBlameCommit>;
  lines: Map<number, string | null>;
  fetchedChunks: Set<number>;
  /** Reads of a chunk that ended without a complete answer (failed or capped). */
  attempts: Map<number, number>;
  /** Fetched chunks, oldest first: past `maxChunksPerFile` the oldest is let go. */
  chunkOrder: number[];
}

const maxCachedFiles = 24;
/** Reads of one chunk that may end without a complete answer before it is left unblamed. */
export const maxChunkAttempts = 3;
/** One read per chunk, shared by every pane showing it; each pane waits on its own signal. */
const chunkReads = new SharedWork<void>();
/** Committed lines kept per file: `maxChunksPerFile` × `blameChunkSize`. */
export const maxChunksPerFile = 24;
const blameCache = new Map<string, BlameFileCache>();
const cacheListeners = new Set<() => void>();

function notifyCache(): void {
  for (const listener of cacheListeners) listener();
}

function subscribeCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => void cacheListeners.delete(listener);
}

function getOrCreateCache(key: string): BlameFileCache {
  let entry = blameCache.get(key);
  if (entry) {
    blameCache.delete(key);
    blameCache.set(key, entry);
    return entry;
  }
  entry = {
    commits: new Map(),
    lines: new Map(),
    fetchedChunks: new Set(),
    attempts: new Map(),
    chunkOrder: [],
  };
  blameCache.set(key, entry);
  if (blameCache.size > maxCachedFiles) {
    const oldest = blameCache.keys().next().value;
    if (oldest !== undefined) blameCache.delete(oldest);
  }
  return entry;
}

/** Keeps a chunk's answer, letting the oldest chunk (and commits no line names) go past the cap. */
function keepChunk(entry: BlameFileCache, chunk: BlameRangeChunk): void {
  entry.fetchedChunks.add(chunk.index);
  entry.chunkOrder.push(chunk.index);
  while (entry.chunkOrder.length > maxChunksPerFile) {
    const oldest = entry.chunkOrder.shift();
    if (oldest === undefined) break;
    entry.fetchedChunks.delete(oldest);
    for (let line = oldest * blameChunkSize + 1; line <= (oldest + 1) * blameChunkSize; line++)
      entry.lines.delete(line);
  }
  if (entry.commits.size > entry.lines.size) {
    const named = new Set(entry.lines.values());
    for (const sha of entry.commits.keys()) if (!named.has(sha)) entry.commits.delete(sha);
  }
}

/** Clears cached blame ranges (used by tests between runs). */
export function clearInlineBlameCache(): void {
  blameCache.clear();
  notifyCache();
}

/** How many committed lines of `path` at `commit` are held (bounded by `maxChunksPerFile`). */
export function heldBlameLines(threadId: string, path: string, commit: string): number {
  return blameCache.get(cacheKeyOf(threadId, path, commit))?.lines.size ?? 0;
}

function cacheKeyOf(threadId: string, path: string, commit: string): string {
  return `${threadId}\u0000${path}\u0000${commit}`;
}

export interface VisibleRange {
  firstLine: number;
  lastLine: number;
  lineCount: number;
}

/** The live gutter's store, as blame reads it: its hunks against `commit` and when they hold. */
export interface BlameGutter {
  state(): GutterState;
  subscribe(listener: () => void): () => void;
}

const inertStatusStore: StatusStore = {
  report: () => {},
  get: () => undefined,
  subscribe: () => () => {},
};

/**
 * The gutter's state while its hunks were worked out on the buffer's text as it is now and
 * against `commit`; undefined while typing has moved past them or they are of another commit
 * (the lines can't be mapped to the blamed commit then, and nothing is said).
 */
function currentGutter(
  gutter: BlameGutter,
  buffer: TextBuffer,
  commit: string | undefined,
): GutterState | undefined {
  const state = gutter.state();
  const basis = state.basis;
  // No committed text to compare with yet (an untracked file, or a read still out): lines map
  // to themselves only while the text is what is on disk.
  if (!basis) return state.hunks.length === 0 && !buffer.snapshot().dirty ? state : undefined;
  const doc = buffer.document();
  // Hunks against another commit than the one blamed would map lines to the wrong file.
  return doc !== undefined &&
    basis.doc === doc &&
    basis.version === doc.version() &&
    basis.commit === commit
    ? state
    : undefined;
}

/**
 * Inline git blame on the caret line of one pane, off by default (no requests while off).
 * Blame is read at `commit`, the commit the gutter's hunks compare the text against, for the
 * committed lines behind the visible lines, in whole fixed chunks cached per file and commit (a
 * blame at a commit never changes, so typing and saving never read it again). The caret line is
 * mapped to its committed line through the hunks: a line added or changed since, saved or not,
 * says "You · not committed yet", and nothing is said while the hunks are out of date.
 */
export function useInlineBlame(input: {
  enabled: boolean;
  threadId: string;
  path: string;
  group: string;
  buffer: TextBuffer;
  commit: string | undefined;
  gutter: BlameGutter;
  statusStore?: StatusStore | undefined;
  onOpenCommit?: ((target: CommitDiffTarget) => void) | undefined;
  now?: (() => number) | undefined;
}): {
  onVisibleRange: (range: VisibleRange) => void;
  caretAnnotation: { line: number; content: ReactNode } | undefined;
} {
  const { enabled, threadId, path, group, buffer, commit, gutter, statusStore, onOpenCommit } =
    input;
  const client = useClient();

  // The gutter's state while it holds for the text as typed; rechecked on every edit.
  const subscribeView = useCallback(
    (changed: () => void) => {
      const offs = [
        gutter.subscribe(changed),
        buffer.subscribe(changed),
        onBufferEdits(buffer, changed),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    [gutter, buffer],
  );
  const view = useSyncExternalStore(subscribeView, () => currentGutter(gutter, buffer, commit));
  const report = useStatusReport(statusStore ?? inertStatusStore, group);
  const caretLine = report?.status.line;

  const [visible, setVisible] = useState<VisibleRange | undefined>(undefined);
  const onVisibleRange = useCallback((next: VisibleRange) => {
    setVisible((prev) =>
      prev &&
      prev.firstLine === next.firstLine &&
      prev.lastLine === next.lastLine &&
      prev.lineCount === next.lineCount
        ? prev
        : next,
    );
  }, []);

  const cacheKey = commit === undefined ? undefined : cacheKeyOf(threadId, path, commit);
  const cacheTick = useSyncExternalStore(subscribeCache, () => {
    const entry = cacheKey === undefined ? undefined : blameCache.get(cacheKey);
    return entry
      ? `${entry.fetchedChunks.size}:${entry.lines.size}:${entry.chunkOrder.at(-1)}`
      : "";
  });

  // Each pane waits on its own signal: closing one pane, another file, a new commit or turning
  // blame off leaves the reads it waited on, which stop only when no pane waits for them.
  const scope = useRef<{ key: string; controller: AbortController; joined: Set<number> }>(
    undefined,
  );
  useEffect(
    () => () => {
      scope.current?.controller.abort();
      scope.current = undefined;
    },
    [enabled, cacheKey],
  );

  const hunks = view?.hunks;
  useEffect(() => {
    if (!enabled || !visible || !hunks || commit === undefined || cacheKey === undefined) return;
    const range = committedRange(hunks, visible.firstLine, visible.lastLine);
    if (!range) return;
    const entry = getOrCreateCache(cacheKey);
    if (scope.current?.key !== cacheKey) {
      scope.current?.controller.abort();
      scope.current = { key: cacheKey, controller: new AbortController(), joined: new Set() };
    }
    const own = scope.current;
    const missing = missingBlameChunks(entry.fetchedChunks, range.first, range.last).filter(
      (chunk) =>
        !own.joined.has(chunk.index) && (entry.attempts.get(chunk.index) ?? 0) < maxChunkAttempts,
    );
    for (const chunk of missing) {
      own.joined.add(chunk.index);
      const asked = { commit, startLine: chunk.startLine, endLine: chunk.endLine };
      // Runs once per read, whichever panes wait: only a complete answer marks the chunk.
      const read = (signal: AbortSignal) =>
        readGitBlame(client, threadId, path, asked, signal).then(
          (result) => {
            for (const info of result.commits) entry.commits.set(info.sha, info);
            for (const item of result.lines) entry.lines.set(item.line, item.sha);
            if (result.capped) {
              entry.attempts.set(chunk.index, (entry.attempts.get(chunk.index) ?? 0) + 1);
            } else {
              // A line git has no history for at the commit (an untracked file) is not
              // committed yet; only a complete answer can say so.
              for (let line = chunk.startLine; line <= chunk.endLine; line++)
                if (!entry.lines.has(line)) entry.lines.set(line, null);
              keepChunk(entry, chunk);
            }
            notifyCache();
          },
          (error: unknown) => {
            if (!signal.aborted)
              entry.attempts.set(chunk.index, (entry.attempts.get(chunk.index) ?? 0) + 1);
            throw error;
          },
        );
      void chunkReads.join(`${cacheKey}\u0000${chunk.index}`, read, own.controller.signal).then(
        () => own.joined.delete(chunk.index),
        () => {
          own.joined.delete(chunk.index);
          // Another try, while tries remain, the next time this pane looks.
          if (!own.controller.signal.aborted) notifyCache();
        },
      );
    }
  }, [enabled, client, threadId, path, commit, cacheKey, visible, hunks, cacheTick]);

  const [now] = useState(() => (input.now ?? Date.now)());

  // Recomputed when the caret moves, the hunks change or a chunk lands; a few map reads.
  const entry = cacheTick === "" || cacheKey === undefined ? undefined : blameCache.get(cacheKey);
  const committedLine =
    caretLine === undefined || !view ? undefined : committedLineAt(view.hunks, caretLine);
  const attribution: BlameAttribution | undefined =
    enabled && caretLine !== undefined && view
      ? resolveCaretBlame({
          caretLine,
          agentBlocks: view.agent,
          committedLine,
          lineSha: typeof committedLine === "number" ? entry?.lines.get(committedLine) : undefined,
          commits: entry?.commits ?? emptyCommits,
          now,
        })
      : undefined;

  const label = attribution?.label;
  const kind = attribution?.kind;
  const sha = attribution?.kind === "commit" ? attribution.commit.sha : undefined;
  // Keyed on what the badge shows, so the caret line's row redraws only when its words change.
  const caretAnnotation = useMemo(() => {
    if (caretLine === undefined || !attribution) return undefined;
    return {
      line: caretLine,
      content: (
        <InlineBlameBadge path={path} attribution={attribution} onOpenCommit={onOpenCommit} />
      ),
    };
    // oxlint-disable-next-line react/exhaustive-deps -- `attribution` is rebuilt each render; its words are the identity.
  }, [caretLine, label, kind, sha, path, onOpenCommit]);

  return { onVisibleRange, caretAnnotation };
}

const emptyCommits: ReadonlyMap<string, GitBlameCommit> = new Map();

function InlineBlameBadge(props: {
  path: string;
  attribution: BlameAttribution;
  onOpenCommit?: ((target: CommitDiffTarget) => void) | undefined;
}) {
  const { path, attribution, onOpenCommit } = props;
  const [copied, setCopied] = useState(false);

  if (attribution.kind !== "commit") {
    return (
      <span
        data-blame-kind={attribution.kind}
        className="max-w-[420px] truncate font-sans text-xs text-faint-foreground/85"
      >
        {attribution.label}
      </span>
    );
  }

  const { commit, age } = attribution;
  const fullDate = new Date(commit.authoredAt).toLocaleString();
  const openChanges = () =>
    onOpenCommit?.({
      path,
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      authorName: commit.authorName,
      authoredAt: commit.authoredAt,
    });
  const copySha = () => {
    void navigator.clipboard?.writeText(commit.sha).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            data-blame-kind="commit"
            className="max-w-[420px] cursor-pointer truncate rounded-xs px-1 font-sans text-xs text-faint-foreground/85 transition-colors duration-(--motion-fast) hover:text-muted-foreground focus-ring-inset"
          />
        }
      >
        {attribution.label}
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={6}
        className="ace-floating-solid w-80 p-3 font-sans"
      >
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-subtle-foreground">
            <GitCommitIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
            <span className="font-mono text-foreground">{commit.shortSha}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{age}</span>
            <span className="ml-auto">
              <IconButton
                label={copied ? "Copied commit id" : "Copy commit id"}
                icon={copied ? CheckIcon : CopyIcon}
                size="sm"
                onClick={copySha}
                className="size-6 rounded-sm hover:bg-hover"
              />
            </span>
          </div>
          <p className="text-ui leading-5 font-medium break-words text-foreground">
            {commit.subject || commit.shortSha}
          </p>
          <div className="flex flex-col gap-0.5 text-[11px] text-subtle-foreground">
            <span>
              {commit.authorName}
              {commit.authorEmail ? ` <${commit.authorEmail}>` : ""}
            </span>
            <span>{fullDate}</span>
          </div>
          {onOpenCommit && (
            <div className="flex justify-end border-t border-border-soft pt-2">
              <Button size="sm" variant="secondary" onClick={openChanges}>
                Open changes
              </Button>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
