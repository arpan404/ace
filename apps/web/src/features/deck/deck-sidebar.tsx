import { CardsIcon, PlusIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Icon } from "@/components/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ViewSidebar } from "@/features/shell/view-frame.tsx";

/**
 * Deck's second sidebar: every deck (multi-agent run). Internally a conductor run.
 * TODO(deck slice): list decks from @ace/conductor state with their status line.
 */
export function DeckSidebar() {
  return (
    <ViewSidebar title="Deck">
      <Link
        to="/deck/new"
        className="mb-1.5 flex h-8 items-center gap-[9px] rounded-md px-2.5 text-ui font-medium text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent [&_svg]:text-muted-foreground"
      >
        <Icon icon={PlusIcon} />
        New deck
        <Kbd keys="shift+mod+n" variant="bare" className="ml-auto" />
      </Link>
      <EmptyState
        icon={CardsIcon}
        title="No decks yet"
        description="A deck splits a goal into cards, deals them to agents and merges the results."
      />
    </ViewSidebar>
  );
}
