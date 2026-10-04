import {
  FolderSimpleIcon,
  GitBranchIcon,
  LaptopIcon,
  MoonIcon,
  PushPinIcon,
} from "@phosphor-icons/react";
import type { ProviderKind } from "@ace/protocol";
import type { ThreadCard, ThreadMarkKind } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * Pure pieces of a Home row. They render a `ThreadCard` view model and know nothing about the
 * client, the organizer or routing.
 */

/**
 * The only colour on a row: an amber dot for needs you, red for failed, a hollow ring for
 * unresponsive and a grey spinner while it works; waiting and done show nothing. The status word
 * is for assistive tech.
 */
export function StatusMark(props: { mark: ThreadMarkKind; label: string }) {
  return (
    <>
      {props.mark === "working" ? (
        <Spinner />
      ) : props.mark === "none" ? null : (
        <Dot tone={props.mark} />
      )}
      <span className="sr-only">{props.label}</span>
    </>
  );
}

/** Provider mark with the running subagent count beside it. */
export function ProviderMark(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  subagents: number;
  label: string;
}) {
  return (
    <Tip label={props.label}>
      <span className="inline-flex items-center gap-[3px] text-xs text-subtle-foreground">
        <ProviderIcon
          provider={props.provider}
          acpAgentId={props.acpAgentId}
          decorative
          className="text-muted-foreground"
        />
        {props.subagents > 0 && <span aria-hidden>{props.subagents}</span>}
        <span className="sr-only">{props.label}</span>
      </span>
    </Tip>
  );
}

/** Line-one glyphs: another machine, pinned, snoozed. Each says what it means on hover. */
export function RowGlyphs(props: {
  machine?: string | undefined;
  pinned: boolean;
  wake?: string | undefined;
}) {
  return (
    <>
      {props.machine && <Glyph icon={LaptopIcon} label={`Running on ${props.machine}`} />}
      {props.pinned && <Glyph icon={PushPinIcon} label="Pinned" />}
      {props.wake && <Glyph icon={MoonIcon} label={`Snoozed until ${props.wake}`} />}
    </>
  );
}

function Glyph(props: { icon: typeof LaptopIcon; label: string }) {
  return (
    <Tip label={props.label}>
      <span className="inline-flex text-subtle-foreground">
        <Icon icon={props.icon} size={13} label={props.label} />
      </span>
    </Tip>
  );
}

/** The card's title: medium when it needs you, is unread or is the open thread. */
export function CardTitle(props: { card: ThreadCard }) {
  return (
    <span
      className={cn(
        "col-span-2 line-clamp-2 text-base leading-[1.3] tracking-[-0.005em] text-muted-foreground compact:line-clamp-1",
        "group-data-[status=active]/link:font-medium group-data-[status=active]/link:text-foreground",
        props.card.emphasis && "font-medium text-foreground",
      )}
    >
      {props.card.title}
      {props.card.announceUnread && <span className="sr-only">, unread</span>}
    </span>
  );
}

/**
 * A Home card's four cells: project and glyphs with the age, the title (or whatever replaces it
 * while renaming), branch and PR, and the status and provider marks.
 */
export function CardLines(props: { card: ThreadCard; title: ReactNode }) {
  const { card } = props;
  return (
    <>
      {/* Settle and Snooze float over this line's end on hover; it fades under them. */}
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-subtle-foreground [--under:6.75rem] group-focus-within/row:fade-under-actions group-hover/row:fade-under-actions">
        <span className="truncate">{card.project}</span>
        <RowGlyphs machine={card.machine} pinned={card.flags.pinned} wake={card.wake} />
      </span>
      <span className="self-center text-xs whitespace-nowrap text-subtle-foreground group-focus-within/row:invisible group-hover/row:invisible">
        {card.age}
      </span>
      {props.title}
      <span className="flex min-w-0 items-center gap-[5px] font-mono text-[11px] text-subtle-foreground">
        {card.branch ? (
          <>
            <Icon icon={card.branch.worktree ? FolderSimpleIcon : GitBranchIcon} size={12} />
            <span className="truncate">{card.branch.name}</span>
            {card.branch.pr !== undefined && (
              <span className="shrink-0 font-sans text-xs">#{card.branch.pr}</span>
            )}
          </>
        ) : (
          // No branch reported yet: say where it runs rather than leave the line empty.
          <span className="truncate font-sans text-xs">local checkout</span>
        )}
      </span>
      <span className="flex items-center justify-end gap-2 whitespace-nowrap">
        <StatusMark mark={card.status.mark} label={card.status.label} />
        <ProviderMark
          provider={card.provider}
          acpAgentId={card.acpAgentId}
          subagents={card.subagents}
          label={card.providerLabel}
        />
      </span>
    </>
  );
}

/** A settled row's line: title, status mark and age. */
export function SettledLine(props: { card: ThreadCard }) {
  return (
    <>
      {/* Unsettle covers the title's end on hover; fade it rather than cut it. */}
      <span className="min-w-0 flex-1 truncate [--under:2.25rem] group-focus-within/row:fade-under-actions group-hover/row:fade-under-actions">
        {props.card.title}
      </span>
      <StatusMark mark={props.card.status.mark} label={props.card.status.label} />
      <span className="text-[11px] group-focus-within/row:invisible group-hover/row:invisible">
        {props.card.age}
      </span>
    </>
  );
}
