import { Link } from "@tanstack/react-router";
import { BellIcon, MagnifyingGlassIcon, NotePencilIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import { Icon } from "@/components/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { WorkspaceMenu } from "./account-menu.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";

const quick =
  "grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]";

/**
 * The sidebar beside the rail: "ace ▾" with Activity and Search one click away, New thread,
 * and the current view's own list as its only scrolling part (the threads on Home).
 */
export function AppSidebar() {
  const { sheet, setBody } = useViewFrame();
  const { setPaletteOpen } = useLayout();
  return (
    <>
      <div
        data-slot="sidebar-top"
        className={cn(
          "flex h-(--header-h) shrink-0 items-center gap-0.5 pl-2.5 [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]",
          // The sheet's own close button sits at the row's end.
          sheet ? "pr-12" : "pr-2.5",
        )}
      >
        <WorkspaceMenu />
        <span className="flex-1" />
        <Tip label="Activity" shortcut="goActivity">
          <Link to="/activity" aria-label="Activity" className={quick}>
            <Icon icon={BellIcon} />
          </Link>
        </Tip>
        <Tip label="Search" shortcut="palette">
          <button
            type="button"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
            className={quick}
          >
            <Icon icon={MagnifyingGlassIcon} />
          </button>
        </Tip>
      </div>
      <Link
        to="/new"
        className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-[9px] rounded-md bg-sidebar-accent px-2.5 text-ui font-medium text-sidebar-foreground outline-none transition-colors duration-(--dur-1) hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--foreground)_4%)] focus-visible:shadow-[0_0_0_2px_var(--ring)] [&_svg]:text-muted-foreground"
      >
        <Icon icon={NotePencilIcon} />
        New thread
        <Kbd keys="mod+n" variant="bare" className="ml-auto" />
      </Link>
      {/* The current view's list (`ViewFrame`): the only part of the sidebar that scrolls. */}
      <div ref={setBody} className="flex min-h-0 flex-1 flex-col" />
    </>
  );
}
