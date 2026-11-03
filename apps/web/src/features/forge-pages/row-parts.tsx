import type { MouseEvent, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { formatAge, type LinkedThread } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { PersonAvatar as PrAvatar } from "@/components/person-avatar.tsx";

/** A two-line list row: the whole row opens the item's page. */
export const rowClass = cn(
  "flex w-full min-w-0 gap-3 px-(--forge-gutter) py-2.5 text-left transition-colors duration-(--motion-fast)",
  "hover:bg-hover focus-ring-inset",
);

export function Age(props: { at: string | undefined }) {
  const now = useNow();
  const at = props.at ? Date.parse(props.at) : NaN;
  if (!Number.isFinite(at)) return null;
  return (
    <time dateTime={props.at} title={props.at} className="shrink-0 tabular-nums">
      {formatAge(at, now)}
    </time>
  );
}

export function Comments(props: { count: number | undefined }) {
  if (!props.count) return null;
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {`${props.count} ${props.count === 1 ? "comment" : "comments"}`}
    </span>
  );
}

export function Author(props: { login: string; avatar?: string | undefined }) {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1">
      <span aria-hidden className="inline-flex">
        <PrAvatar name={props.login} url={props.avatar} className="size-4 min-w-4" />
      </span>
      <span className="truncate">{props.login}</span>
    </span>
  );
}

export function Thread(props: { thread: LinkedThread | undefined }) {
  if (!props.thread) return null;
  return (
    <span className="min-w-0 truncate" title={`Thread: ${props.thread.title}`}>
      {`Thread: ${props.thread.title}`}
    </span>
  );
}

/** The project a row belongs to, at the start of its second line: its name, in words. */
export function ProjectTag(props: { name: string }) {
  return <span className="min-w-0 shrink truncate text-muted-foreground">{props.name}</span>;
}

/** The quiet dot between a row's facts. */
export function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-subtle-foreground">
      ·
    </span>
  );
}

/** A group of rows: its name and its count ("3", or "2 of 12" while some are unread), with room above and no rule; the rows' own hairlines are the only lines. */
export function GroupHeader(props: {
  label: string;
  count: number | string | undefined;
  /** The list's first: right under the bar, so little room above. */
  first?: boolean | undefined;
}) {
  return (
    <h2
      className={cn(
        "flex items-center gap-2 px-(--forge-gutter) pb-1 text-xs font-medium text-muted-foreground",
        props.first ? "pt-3" : "pt-6",
      )}
    >
      {props.label}
      {props.count !== undefined && (
        <span className="font-normal text-subtle-foreground tabular-nums">{props.count}</span>
      )}
    </h2>
  );
}

/** A text action at a row's right: a word in the text colour, brighter on hover. */
export const rowActionClass =
  "inline-flex h-6 items-center rounded-sm px-1.5 text-meta font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover disabled:opacity-50";

/** Open a pull request or issue on GitHub, saying so when the browser can't be reached. */
export function useOpenOnGitHub() {
  const openWeb = useOpenWebAddress();
  const toast = useToast();
  return (url: string) =>
    void openWeb(url).catch(() => toast.error({ title: "Couldn't open GitHub" }));
}

/** ⌘/Ctrl-click on a row's link opens it on GitHub instead of in ace. */
export function onModifiedClick(url: string | undefined, open: (url: string) => void) {
  return (event: MouseEvent<HTMLElement>) => {
    if (!url || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    open(url);
  };
}

/**
 * A list row's frame: the row itself (its link), and what it offers without opening it. On hover
 * or focus its right column gives way to text actions, right-aligned (the next action, then New
 * thread); a right click opens a menu with the rest (Open on GitHub, Copy link). `pinned` keeps
 * the actions showing (a row picked for merging).
 */
export function RowShell(props: {
  /** Names the row's menu: "#229 Reconnect the client worker". */
  label: string;
  url: string | undefined;
  /** The row's text actions; New thread goes last when offered. */
  actions: ReactNode;
  onNewThread?: (() => void) | undefined;
  /** Further menu items, before Open on GitHub. */
  menu?: ReactNode;
  pinned?: boolean | undefined;
  selected?: boolean | undefined;
  /** The last of its group: no rule under it. */
  last?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const openOnGitHub = useOpenOnGitHub();
  const url = props.url;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              "group/row relative",
              !props.last && "border-b border-border",
              props.className,
            )}
          />
        }
      >
        {props.children}
        <span
          className={cn(
            "absolute inset-y-0 right-0 items-center",
            props.pinned ? "flex" : "hidden group-focus-within/row:flex group-hover/row:flex",
            props.selected ? "bg-active" : "bg-background",
          )}
        >
          <span
            className={cn(
              "flex h-full items-center gap-0.5 pr-[calc(var(--forge-gutter)-0.375rem)] pl-3",
              !props.selected && "bg-hover",
            )}
          >
            {props.actions}
            {props.onNewThread && (
              <>
                {props.actions && <Dot />}
                <button type="button" className={rowActionClass} onClick={props.onNewThread}>
                  New thread
                </button>
              </>
            )}
          </span>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`Actions for ${props.label}`}>
        {props.menu}
        {props.onNewThread && <MenuItem onClick={props.onNewThread}>New thread</MenuItem>}
        {url && (
          <>
            <MenuItem onClick={() => openOnGitHub(url)}>Open on GitHub</MenuItem>
            <MenuItem onClick={() => void navigator.clipboard?.writeText(url)}>Copy link</MenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
