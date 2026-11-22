import { useClient, useThreadMeta } from "@ace/client-react";
import { CaretDownIcon, CaretRightIcon, CheckIcon, CopyIcon, GitCommitIcon } from "@ace/icons";
import type { GitLogEntry } from "@ace/protocol";
import { useEffect, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { formatRelativeWords, readGitLog, type CommitDiffTarget } from "@/lib/git-history.ts";

const pageSize = 25;

interface TimelineData {
  key: string;
  entries: readonly GitLogEntry[];
  hasMore: boolean;
  nextSkip: number | undefined;
  capped: boolean;
  error: string | undefined;
  loadingMore: boolean;
}

/**
 * Collapsible "Timeline" section under Outline at the bottom of the Files view.
 * Lists the active file's git history from `git.log` (subject, author, relative time), paged,
 * opens a read-only commit diff on click, and offers "Copy commit id".
 */
export function EditorTimeline(props: {
  threadId: string;
  path: string | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
  activeCommitSha?: string | undefined;
  onOpenCommit(target: CommitDiffTarget): void;
  now?: (() => number) | undefined;
}) {
  const { threadId, path, open, onOpenChange, activeCommitSha, onOpenCommit } = props;
  const client = useClient();
  // A new commit moves HEAD: the history is read again.
  const head = useThreadMeta(threadId)?.details?.head ?? "";
  const requestKey = open && path !== undefined ? `${threadId}:${path}:${head}` : undefined;
  const [data, setData] = useState<TimelineData | undefined>(undefined);
  const [copiedSha, setCopiedSha] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!requestKey || path === undefined) return;
    const controller = new AbortController();
    void readGitLog(client, threadId, path, {
      skip: 0,
      limit: pageSize,
      signal: controller.signal,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setData({
          key: requestKey,
          entries: result.entries,
          hasMore: result.hasMore,
          nextSkip: result.nextSkip,
          capped: result.capped,
          error: undefined,
          loadingMore: false,
        });
      },
      () => {
        if (controller.signal.aborted) return;
        setData({
          key: requestKey,
          entries: [],
          hasMore: false,
          nextSkip: 0,
          capped: false,
          error: "Couldn't read this file's history.",
          loadingMore: false,
        });
      },
    );
    return () => controller.abort();
  }, [client, threadId, path, requestKey]);

  const active = requestKey !== undefined && data?.key === requestKey ? data : undefined;
  const Caret = open ? CaretDownIcon : CaretRightIcon;

  const loadMore = () => {
    if (
      !active ||
      !path ||
      !requestKey ||
      !active.hasMore ||
      active.nextSkip === undefined ||
      active.loadingMore
    )
      return;
    setData({ ...active, loadingMore: true });
    void readGitLog(client, threadId, path, { skip: active.nextSkip, limit: pageSize }).then(
      (result) => {
        setData((prev) =>
          prev && prev.key === requestKey
            ? {
                ...prev,
                entries: [...prev.entries, ...result.entries],
                hasMore: result.hasMore,
                nextSkip: result.nextSkip,
                capped: prev.capped || result.capped,
                loadingMore: false,
              }
            : prev,
        );
      },
      () => {
        setData((prev) =>
          prev && prev.key === requestKey
            ? {
                ...prev,
                error: "Couldn't read older commits.",
                loadingMore: false,
              }
            : prev,
        );
      },
    );
  };

  const copyCommitId = (sha: string) => {
    void navigator.clipboard?.writeText(sha).catch(() => undefined);
    setCopiedSha(sha);
    setTimeout(() => setCopiedSha((was) => (was === sha ? undefined : was)), 1500);
  };

  const toTarget = (entry: GitLogEntry): CommitDiffTarget => ({
    path: entry.path ?? path ?? "",
    previousPath: entry.previousPath,
    sha: entry.sha,
    shortSha: entry.shortSha,
    subject: entry.subject,
    authorName: entry.authorName,
    authoredAt: entry.authoredAt,
  });

  const [now] = useState(() => (props.now ?? Date.now)());

  return (
    <section
      aria-label="Timeline"
      data-part="editor-timeline"
      className="flex shrink-0 flex-col border-t border-border"
    >
      <div className="flex h-7 items-center pr-1.5 pl-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground focus-ring-inset hover:text-foreground"
        >
          <Caret aria-hidden size={12} className="text-faint-foreground" />
          Timeline
        </button>
      </div>

      {open && (
        <div className="max-h-56 overflow-x-hidden overflow-y-auto pb-1.5">
          {path === undefined ? (
            <p className="px-3 py-2 text-xs text-subtle-foreground">No file open.</p>
          ) : !active ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-subtle-foreground">
              <Spinner />
              Loading history…
            </div>
          ) : active.error ? (
            <p className="px-3 py-2 text-xs text-subtle-foreground">{active.error}</p>
          ) : active.entries.length === 0 ? (
            <p className="px-3 py-2 text-xs text-subtle-foreground">
              No commits for this file yet.
            </p>
          ) : (
            <>
              <ul role="list" aria-label="File commits" className="flex flex-col">
                {active.entries.map((entry) => {
                  const selected = activeCommitSha === entry.sha;
                  const copied = copiedSha === entry.sha;
                  const age = formatRelativeWords(entry.authoredAt, now);
                  return (
                    <li key={entry.sha} className="group mx-1.5">
                      <ContextMenu>
                        <ContextMenuTrigger
                          render={
                            <div
                              className={cn(
                                "flex items-center gap-1 rounded-sm pr-1 pl-2 transition-colors duration-(--motion-fast)",
                                selected
                                  ? "bg-active text-foreground"
                                  : "text-muted-foreground hover:bg-hover hover:text-foreground",
                              )}
                            />
                          }
                        >
                          <button
                            type="button"
                            aria-current={selected ? "true" : undefined}
                            title={`${entry.subject}\n${entry.authorName} · ${entry.shortSha}`}
                            onClick={() => onOpenCommit(toTarget(entry))}
                            className="flex min-w-0 flex-1 items-start gap-1.5 py-1.5 text-left focus-ring-inset"
                          >
                            <GitCommitIcon
                              aria-hidden
                              size={13}
                              className="mt-0.5 shrink-0 text-faint-foreground"
                            />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-xs leading-4 text-foreground">
                                {entry.subject || entry.shortSha}
                              </span>
                              <span className="flex items-center gap-1 truncate text-[11px] leading-4 text-subtle-foreground">
                                <span className="truncate">{entry.authorName}</span>
                                <span aria-hidden>·</span>
                                <span className="shrink-0">{age}</span>
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Copy commit id ${entry.shortSha}`}
                            title={
                              copied ? "Copied commit id" : `Copy commit id (${entry.shortSha})`
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              copyCommitId(entry.sha);
                            }}
                            className={cn(
                              "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-faint-foreground transition-opacity hover:bg-hover hover:text-foreground focus-ring-inset",
                              copied
                                ? "opacity-100 text-foreground"
                                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                            )}
                          >
                            {copied ? (
                              <CheckIcon aria-hidden size={12} />
                            ) : (
                              <CopyIcon aria-hidden size={12} />
                            )}
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <MenuItem onClick={() => onOpenCommit(toTarget(entry))}>
                            Open changes
                          </MenuItem>
                          <MenuItem onClick={() => copyCommitId(entry.sha)}>
                            Copy commit id
                          </MenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    </li>
                  );
                })}
              </ul>
              {active.capped && !active.hasMore && (
                <p className="px-3 pt-1 text-[11px] text-subtle-foreground">
                  Older commits are too long to list here.
                </p>
              )}
              {active.hasMore && (
                <div className="px-2 pt-1">
                  <button
                    type="button"
                    disabled={active.loadingMore}
                    onClick={loadMore}
                    className="flex h-6 w-full items-center justify-center rounded-sm text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-50"
                  >
                    {active.loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
