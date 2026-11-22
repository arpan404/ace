import { useClient } from "@ace/client-react";
import { CheckIcon, CopyIcon, GitCommitIcon } from "@ace/icons";
import type { GitBlameCommit } from "@ace/protocol";
import type { LineMark } from "@ace/ui-core";
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
  useStatusReport,
  type StatusStore,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { readGitBlame, type CommitDiffTarget } from "@/lib/git-history.ts";
import type { AgentBlock } from "./agent-lines.ts";
import { missingBlameChunks, resolveCaretBlame, type BlameAttribution } from "./inline-blame.ts";

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
  inflightChunks: Set<number>;
}

const maxCachedFiles = 24;
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
    inflightChunks: new Set(),
  };
  blameCache.set(key, entry);
  if (blameCache.size > maxCachedFiles) {
    const oldest = blameCache.keys().next().value;
    if (oldest !== undefined) blameCache.delete(oldest);
  }
  return entry;
}

/** Clears cached blame ranges (used by tests between runs). */
export function clearInlineBlameCache(): void {
  blameCache.clear();
  notifyCache();
}

export interface VisibleRange {
  firstLine: number;
  lastLine: number;
  lineCount: number;
}

const inertStatusStore: StatusStore = {
  report: () => {},
  get: () => undefined,
  subscribe: () => () => {},
};

/**
 * Visible-range inline git blame for one editor pane:
 * - Off by default (`enabled: false` issues zero requests).
 * - Fetches `git.blame` for visible line chunks only, cached per `(threadId, path, head, diskVersion)`.
 * - Recomputes only when saved (`diskVersion` changes) or HEAD changes, never per keystroke.
 * - Renders a quiet end-of-line annotation on the caret line only, with a hover card showing the
 *   full commit and "Open changes".
 */
export function useInlineBlame(input: {
  enabled: boolean;
  threadId: string;
  path: string;
  group: string;
  buffer: TextBuffer;
  head: string | undefined;
  agentBlocks: readonly AgentBlock[];
  marks: ReadonlyMap<number, LineMark> | undefined;
  statusStore?: StatusStore | undefined;
  onOpenCommit?: ((target: CommitDiffTarget) => void) | undefined;
  now?: (() => number) | undefined;
}): {
  onVisibleRange: (range: VisibleRange) => void;
  caretAnnotation: { line: number; content: ReactNode } | undefined;
} {
  const {
    enabled,
    threadId,
    path,
    group,
    buffer,
    head,
    agentBlocks,
    marks,
    statusStore,
    onOpenCommit,
  } = input;
  const client = useClient();

  const onBuffer = useCallback((changed: () => void) => buffer.subscribe(changed), [buffer]);
  // `version` changes ONLY on load, save, or reload — never on typing keystrokes.
  const diskVersion = useSyncExternalStore(onBuffer, () => buffer.snapshot().version);
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

  const cacheKey = `${threadId}\u0000${path}\u0000${head ?? ""}\u0000${diskVersion ?? ""}`;
  const cacheTick = useSyncExternalStore(subscribeCache, () => {
    const entry = blameCache.get(cacheKey);
    return entry ? `${entry.fetchedChunks.size}:${entry.lines.size}` : "";
  });

  // One abort scope per file version: scrolling never cancels a read still on screen, while a
  // save, a new HEAD, another file or turning blame off drops what is in flight.
  const scope = useRef<{ key: string; controller: AbortController } | undefined>(undefined);
  useEffect(
    () => () => {
      scope.current?.controller.abort();
      scope.current = undefined;
    },
    [enabled, cacheKey],
  );

  useEffect(() => {
    if (!enabled || !visible) return;
    const entry = getOrCreateCache(cacheKey);
    const missing = missingBlameChunks(
      entry.fetchedChunks,
      visible.firstLine,
      visible.lastLine,
      visible.lineCount,
    ).filter((chunk) => !entry.inflightChunks.has(chunk.index));
    if (missing.length === 0) return;
    if (scope.current?.key !== cacheKey) {
      scope.current?.controller.abort();
      scope.current = { key: cacheKey, controller: new AbortController() };
    }
    const { signal } = scope.current.controller;
    for (const chunk of missing) {
      entry.inflightChunks.add(chunk.index);
      const settle = () => {
        entry.inflightChunks.delete(chunk.index);
        if (signal.aborted) return false;
        // A failed read is not asked again for this file version: no request storm on scroll.
        entry.fetchedChunks.add(chunk.index);
        return true;
      };
      void readGitBlame(client, threadId, path, chunk.startLine, chunk.endLine, signal).then(
        (result) => {
          if (!settle()) return;
          for (const commit of result.commits) entry.commits.set(commit.sha, commit);
          for (const item of result.lines) entry.lines.set(item.line, item.sha);
          // A line git has no history for (an untracked file, past the end on disk) is not
          // committed yet; a capped read proves nothing about the lines it left out.
          if (!result.capped)
            for (let line = chunk.startLine; line <= chunk.endLine; line++)
              if (!entry.lines.has(line)) entry.lines.set(line, null);
          notifyCache();
        },
        () => {
          if (settle()) notifyCache();
        },
      );
    }
  }, [enabled, client, threadId, path, cacheKey, visible]);

  const [now] = useState(() => (input.now ?? Date.now)());

  // Recomputed when the caret moves or a chunk lands (`cacheTick`); it is a few map reads.
  const entry = cacheTick === "" ? undefined : blameCache.get(cacheKey);
  const attribution: BlameAttribution | undefined =
    enabled && caretLine !== undefined
      ? resolveCaretBlame({
          caretLine,
          agentBlocks,
          marks,
          lineSha: entry?.lines.get(caretLine),
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
