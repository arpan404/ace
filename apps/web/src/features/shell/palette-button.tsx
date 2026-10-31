import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";

/**
 * Search in a panel's title row: opens the palette (⌘K) over the current screen, the one way to
 * it on a touch screen. From the narrow window's sheet, the palette takes the sheet's place.
 */
export function PaletteButton() {
  const { sheet, hideSidebar } = useViewFrame();
  const { setPaletteOpen } = useLayout();
  return (
    <Tip label="Search" shortcut="palette">
      <button
        type="button"
        aria-label="Search"
        aria-haspopup="dialog"
        onClick={() => {
          if (sheet) hideSidebar();
          setPaletteOpen(true);
        }}
        className="relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:bg-hover hover:text-foreground"
      >
        <Icon icon={MagnifyingGlassIcon} />
      </button>
    </Tip>
  );
}
