import { MagnifyingGlassIcon, NotePencilIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { ChatsIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { SidebarHeader } from "@/features/shell/view-frame.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { useHomeThreadIds } from "./use-home-threads.ts";
import { ThreadRow } from "./thread-row.tsx";

/**
 * Home's second sidebar: New thread, search, and every thread from every project and
 * machine in one list. TODO(home slice): rich cards, Settled section, hover and context
 * actions, virtualization.
 */
export function HomeSidebar() {
  const ids = useHomeThreadIds();
  const { setPaletteOpen } = useLayout();
  return (
    <>
      <SidebarHeader title="Threads" />
      <Link
        to="/new"
        className="mx-2 mb-1.5 flex h-8 items-center gap-[9px] rounded-md px-2.5 text-ui font-medium text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent [&_svg]:text-muted-foreground"
      >
        <Icon icon={NotePencilIcon} />
        New thread
        <Kbd keys="mod+n" variant="bare" className="ml-auto" />
      </Link>
      <div className="shrink-0 pr-2.5 pb-2 pl-3">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-[9px] bg-sidebar-accent pr-2 pl-2.5 text-ui text-subtle-foreground transition-[background-color,box-shadow] duration-150 hover:shadow-[var(--glass-highlight)]"
        >
          <Icon icon={MagnifyingGlassIcon} />
          Search
          <Kbd keys="mod+k" variant="outline" className="ml-auto" />
        </button>
      </div>
      <nav aria-label="Threads" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {ids.length ? (
          <ul className="flex flex-col gap-px">
            {ids.map((id) => (
              <li key={id}>
                <ThreadRow threadId={id} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={ChatsIcon}
            title="No threads yet"
            description="Start one with ⌘N. Threads from every project and machine land here."
          />
        )}
      </nav>
    </>
  );
}
