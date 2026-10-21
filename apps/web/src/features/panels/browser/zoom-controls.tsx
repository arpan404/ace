import { MagnifyingGlassPlusIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { PageTools } from "./use-page-tools.ts";
import { zoomIn, zoomLabel, zoomOut } from "@ace/ui-core";

/**
 * Zoom in the ⋯ menu: − and + step through a browser's zoom levels and the percentage between
 * them puts the page back at 100%. The menu stays open while you step.
 */
export function ZoomRow(props: { tools: PageTools }) {
  const { tools } = props;
  const off = !tools.canZoom;
  return (
    <div
      role="group"
      aria-label="Zoom"
      className={cn(
        "flex h-7.5 items-center gap-[9px] px-2 text-ui text-foreground [&_svg]:size-4",
        off && "opacity-50",
      )}
    >
      <Icon icon={MagnifyingGlassPlusIcon} className="text-muted-foreground" />
      <span className="min-w-0 flex-1">Zoom</span>
      <span className="flex items-center gap-0.5 rounded-full bg-foreground/5 p-0.5">
        <IconButton
          icon={MinusIcon}
          label="Zoom out"
          keys="mod+-"
          resolve={false}
          size="sm"
          className="rounded-full"
          disabled={off || tools.zoom <= 0.25}
          onClick={() => tools.setZoom(zoomOut(tools.zoom))}
        />
        <Tip label="Actual size" keys="mod+0" resolve={false}>
          <button
            type="button"
            aria-label={`Zoom ${zoomLabel(tools.zoom)}, reset to 100%`}
            disabled={off || tools.zoom === 1}
            onClick={() => tools.setZoom(1)}
            className="h-6 min-w-11 rounded-full px-1 text-xs text-muted-foreground tabular-nums outline-none focus-ring enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-default"
          >
            {zoomLabel(tools.zoom)}
          </button>
        </Tip>
        <IconButton
          icon={PlusIcon}
          label="Zoom in"
          keys="mod+="
          resolve={false}
          size="sm"
          className="rounded-full"
          disabled={off || tools.zoom >= 5}
          onClick={() => tools.setZoom(zoomIn(tools.zoom))}
        />
      </span>
    </div>
  );
}

/**
 * The zoom in the address pill while the page isn't at 100%: it says how far, and a click
 * puts it back.
 */
export function ZoomBadge(props: { tools: PageTools }) {
  const { tools } = props;
  if (tools.zoom === 1 || !tools.canZoom) return null;
  return (
    <Tip label="Reset zoom to 100%" keys="mod+0" resolve={false}>
      <button
        type="button"
        aria-label={`Zoom ${zoomLabel(tools.zoom)}, reset to 100%`}
        onClick={() => tools.setZoom(1)}
        className="h-6 shrink-0 rounded-full px-2 text-xs text-muted-foreground tabular-nums outline-none focus-ring hover:bg-foreground/8 hover:text-foreground"
      >
        {zoomLabel(tools.zoom)}
      </button>
    </Tip>
  );
}
