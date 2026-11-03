import type { ReactNode } from "react";
import {
  ArrowSquareOutIcon,
  ChatCircleIcon,
  ChatsCircleIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { formatAge, projectBadge, type LinkedThread } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { PersonAvatar as PrAvatar } from "@/components/person-avatar.tsx";
import { ProjectMark } from "@/components/project-mark.tsx";

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
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
      <ChatCircleIcon aria-hidden size={14} />
      <span className="sr-only">{`${props.count} comments`}</span>
      <span aria-hidden>{props.count}</span>
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
    <span
      className="inline-flex min-w-0 items-center gap-1"
      title={`Thread: ${props.thread.title}`}
    >
      <ChatsCircleIcon aria-hidden size={12} className="shrink-0" />
      <span className="truncate">{props.thread.title}</span>
    </span>
  );
}

/**
 * The project a row belongs to, at the start of its second line: its mark and name; a narrow
 * list keeps the mark and names it for assistive tech.
 */
export function ProjectTag(props: { id: string; name: string }) {
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1.5 text-muted-foreground">
      <ProjectMark id={props.id} badge={projectBadge({ id: props.id, name: props.name })} />
      <span className="sr-only truncate @lg/list:not-sr-only">{props.name}</span>
    </span>
  );
}

/** The quiet dot between a row's facts. */
export function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-subtle-foreground">
      ·
    </span>
  );
}

/**
 * A group of rows: its glyph, name, its count ("3", or "2 of 12" while some are unread) and a
 * hairline to the edge.
 */
export function GroupHeader(props: {
  icon: IconGlyph;
  label: string;
  count: number | string | undefined;
}) {
  return (
    <h2 className="flex items-center gap-2 px-(--forge-gutter) pt-5 pb-1.5 text-xs font-medium text-muted-foreground">
      <Icon icon={props.icon} size={14} className="text-faint-foreground" />
      {props.label}
      {props.count !== undefined && (
        <span className="font-normal text-subtle-foreground tabular-nums">{props.count}</span>
      )}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </h2>
  );
}

/**
 * The actions a hovered or focused row offers without opening it, at its top right, or left of
 * a right column (`beside`) the row keeps for its status.
 */
export function RowActions(props: {
  url: string;
  onNewThread(): void;
  onOpenExternal(): void;
  children?: ReactNode;
  beside?: boolean | undefined;
}) {
  return (
    <span
      className={cn(
        "absolute hidden items-center gap-0.5 rounded-md bg-hover group-focus-within/row:flex group-hover/row:flex",
        props.beside
          ? "top-1/2 right-[calc(var(--forge-gutter)+var(--row-side))] -translate-y-1/2"
          : "top-1.5 right-[calc(var(--forge-gutter)-0.5rem)]",
      )}
    >
      {props.children}
      <IconButton
        size="sm"
        icon={PlusIcon}
        label="New thread from this"
        onClick={props.onNewThread}
      />
      <IconButton
        size="sm"
        icon={ArrowSquareOutIcon}
        label="Open on GitHub"
        onClick={props.onOpenExternal}
      />
    </span>
  );
}
