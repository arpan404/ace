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
import { formatAge, type LinkedThread } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { PersonAvatar as PrAvatar } from "@/components/person-avatar.tsx";

/** A two-line list row: the whole row opens the item's page. */
export const rowClass = cn(
  "flex w-full min-w-0 gap-3 px-(--forge-gutter) py-2.5 text-left transition-colors duration-(--motion-fast)",
  "hover:bg-hover focus-ring-inset",
);

/** "feature/very-long-bran…name": a long name keeps its start and its end. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

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

/** A group of rows: its glyph, name, GitHub's total once known, and a hairline to the edge. */
export function GroupHeader(props: { icon: IconGlyph; label: string; count: number | undefined }) {
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

/** The actions a hovered or focused row offers without opening it. */
export function RowActions(props: {
  url: string;
  onNewThread(): void;
  onOpenExternal(): void;
  children?: ReactNode;
}) {
  return (
    <span className="absolute top-1.5 right-[calc(var(--forge-gutter)-0.5rem)] hidden items-center gap-0.5 rounded-md bg-hover group-focus-within/row:flex group-hover/row:flex">
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
