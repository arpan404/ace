import type { MouseEvent, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { formatAgo } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";

/** How long ago, in words ("2 hours ago"), with the exact time on hover. */
export function Ago(props: { at: string | undefined }) {
  const now = useNow();
  const at = props.at ? Date.parse(props.at) : NaN;
  if (!Number.isFinite(at)) return null;
  return (
    <time dateTime={props.at} title={props.at}>
      {formatAgo(at, now)}
    </time>
  );
}

/** The quiet dot between a row's facts. */
export function Dot() {
  return (
    <span aria-hidden className="shrink-0">
      ·
    </span>
  );
}

/** A small text action inside a row: a word, brighter on hover. */
export const rowActionClass =
  "inline-flex h-6 items-center rounded-sm px-1.5 text-xs font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover disabled:opacity-50";

/** Open a pull request or issue on its host, reporting browser failures. */
export function useOpenOnGitHub() {
  const openWeb = useOpenWebAddress();
  const toast = useToast();
  return (url: string) =>
    void openWeb(url).catch(() => toast.error({ title: "Couldn't open the host page" }));
}

/** ⌘/Ctrl-click on a row's link opens it on its host instead of in ace. */
export function onModifiedClick(url: string | undefined, open: (url: string) => void) {
  return (event: MouseEvent<HTMLElement>) => {
    if (!url || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    open(url);
  };
}

/**
 * A row of a list box: a hairline under it but the last, and a right-click menu with what it
 * offers without opening it (the row's own items, New thread, Open on GitHub, Copy link).
 */
export function RowShell(props: {
  /** Names the row's menu: "#229 Reconnect the client worker". */
  label: string;
  url: string | undefined;
  onNewThread?: (() => void) | undefined;
  /** Further menu items, before New thread. */
  menu?: ReactNode;
  selected?: boolean | undefined;
  last?: boolean | undefined;
  children: ReactNode;
}) {
  const openOnGitHub = useOpenOnGitHub();
  const url = props.url;
  const hostname = url && URL.canParse(url) ? new URL(url).hostname : undefined;
  const host =
    hostname === "github.com"
      ? "GitHub"
      : hostname === "cursor.com"
        ? "Cursor Origin"
        : hostname === "gitlab.com"
          ? "GitLab"
          : "host";
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              "group/row relative",
              !props.last && "border-b border-border",
              props.selected && "bg-active",
            )}
          />
        }
      >
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`Actions for ${props.label}`}>
        {props.menu}
        {props.onNewThread && <MenuItem onClick={props.onNewThread}>New thread</MenuItem>}
        {url && (
          <>
            <MenuItem onClick={() => openOnGitHub(url)}>Open on {host}</MenuItem>
            <MenuItem onClick={() => void navigator.clipboard?.writeText(url)}>Copy link</MenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
