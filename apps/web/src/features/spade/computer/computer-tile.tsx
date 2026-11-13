import { spadeSurfaceHeading, spadeSurfaceLine, type SpadeSurface } from "@ace/ui-core/spade-chat";
import { ArrowsOutSimpleIcon, XIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { surfaceIcons } from "./computer-view.tsx";
import { useBotPicture } from "./stream-picture.tsx";

/**
 * Pinned above the chat while the bot uses its computer: a thumbnail (the supplied picture, else
 * the surface's mark), which surface and
 * where, what it does there, then Take over, Expand and Hide. Clicking the thumbnail expands too.
 * `compact`: the phone's slimmer tile under the header.
 */
export function ComputerTile(props: {
  machine: { key: string; name: string };
  bot: string;
  surface: SpadeSurface;
  driving: boolean;
  pending: boolean;
  compact: boolean;
  onExpand(): void;
  onTakeOver(): void;
  onHide(): void;
}) {
  const { surface } = props;
  const kind = surface.kind;
  const { picture } = useBotPicture(
    kind === "browser" || kind === "screen"
      ? { machine: props.machine.key, bot: props.bot, surface: kind }
      : undefined,
  );
  const heading = spadeSurfaceHeading(surface, props.machine.name);
  const line = spadeSurfaceLine(surface);
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
      {!props.driving && !props.compact && (
        <Button size="sm" variant="ghost" disabled={props.pending} onClick={props.onTakeOver}>
          Take over
        </Button>
      )}
      <IconButton icon={ArrowsOutSimpleIcon} label="Expand" onClick={props.onExpand} />
      {!props.compact && <IconButton icon={XIcon} label="Hide" onClick={props.onHide} />}
    </section>
  );
}
