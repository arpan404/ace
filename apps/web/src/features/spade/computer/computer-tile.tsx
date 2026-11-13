import { coworkLine } from "@ace/ui-core/cowork";
import {
  spadeSurfaceHeading,
  spadeSurfaceLine,
  type SpadeAvatar,
  type SpadeSurface,
} from "@ace/ui-core/spade-chat";
import { ArrowsOutSimpleIcon, XIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { DriverStatus, TakeOver } from "./driver-status.tsx";
import type { BotComputerState } from "./use-bot-computer.ts";
import { surfaceIcons } from "./computer-view.tsx";
import { useBotPicture } from "./stream-picture.tsx";

/**
 * Pinned above the chat while the bot uses its computer: a thumbnail (the supplied picture, else
 * the surface's mark), which surface and
 * where, what it does there (or that it waits for the person), then Take over, Expand and Hide. Clicking the thumbnail expands too.
 * `compact`: the phone's slimmer tile under the header.
 */
export function ComputerTile(props: {
  machine: { key: string; name: string };
  bot: { id: string; name: string; avatar: SpadeAvatar };
  surface: SpadeSurface;
  /** Who drives, with Take over and Hand back. */
  state: BotComputerState;
  compact: boolean;
  onExpand(): void;
  onHide(): void;
}) {
  const { surface } = props;
  const kind = surface.kind;
  const { picture } = useBotPicture(
    kind === "browser" || kind === "screen"
      ? { machine: props.machine.key, bot: props.bot.id, surface: kind }
      : undefined,
  );
  const heading = spadeSurfaceHeading(surface, props.machine.name);
  // While the bot yields to the person's input, that is what it does here.
  const line =
    props.state.status === "waiting" && surface.personActive
      ? coworkLine("waiting", props.bot.name)
      : spadeSurfaceLine(surface);
  return (
    <section
      aria-label={`${heading}, live`}
      className={cn(
        "flex items-center gap-3 rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border)]",
        props.compact ? "p-1.5 pr-2" : "p-2 pr-3",
      )}
    >
      <button
        type="button"
        aria-label={`Expand ${heading}`}
        onClick={props.onExpand}
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-lg bg-code focus-ring",
          props.compact ? "h-10 w-16" : "h-20 w-32",
        )}
      >
        {picture ? (
          <img src={picture.src} alt="" className="size-full object-cover object-top" />
        ) : (
          // No picture supplied: the surface's mark; the expanded view is live.
          <Icon icon={surfaceIcons[kind]} size={20} className="text-muted-foreground" />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-center gap-1.5 text-ui text-foreground">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-working" />
          <span className="truncate">{heading}</span>
        </p>
        {line && <p className="truncate text-xs text-muted-foreground">{line}</p>}
      </div>
      {props.state.paused || props.state.stopping ? (
        // The person has it: who drives and Hand back, here as in the expanded computer.
        <DriverStatus bot={props.bot} state={props.state} brief />
      ) : (
        !props.compact && <TakeOver bot={props.bot.name} state={props.state} variant="ghost" />
      )}
      <IconButton icon={ArrowsOutSimpleIcon} label="Expand" onClick={props.onExpand} />
      {!props.compact && <IconButton icon={XIcon} label="Hide" onClick={props.onHide} />}
    </section>
  );
}
