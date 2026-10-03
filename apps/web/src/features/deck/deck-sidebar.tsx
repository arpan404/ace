import { CardsIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ViewRowBody, ViewRowSection, viewRowClass } from "@/components/ui/view-row.tsx";
import { ViewSidebar, ViewSidebarError } from "@/features/shell/index.ts";
import { deckGroup, deckRunSummary, type DeckRun, type DeckGroup } from "@ace/ui-core";
import { useDeckRetry, useDeckRuns } from "./deck-source.ts";
import { useProjectName } from "@/lib/projects.ts";

const groups: readonly { id: DeckGroup; label: string }[] = [
  { id: "gated", label: "Gated" },
  { id: "active", label: "Active" },
  { id: "finished", label: "Finished" },
];

/** Deck's second sidebar: New deck, then every deck grouped by what it needs. */
export function DeckSidebar() {
  const { ready, error, runs } = useDeckRuns();
  const retry = useDeckRetry();
  const [project, setProject] = useState("all");
  const projectName = useProjectName();
  const projects = [...new Set(runs.map((run) => run.workspaceId))].toSorted();
  const shown = project === "all" ? runs : runs.filter((run) => run.workspaceId === project);
  return (
    <ViewSidebar
      title="Deck"
      actions={
        <FilterMenu
          label="Project"
          value={project}
          options={[
            { value: "all", label: "All projects" },
            ...projects.map((id) => ({ value: id, label: projectName(id) })),
          ]}
          onValueChange={setProject}
        />
      }
    >
      <Link
        to="/deck/new"
        className="mb-1.5 flex h-8 items-center gap-[9px] rounded-md px-2.5 text-ui font-medium text-sidebar-foreground transition-colors duration-(--dur-1) hover:bg-sidebar-accent data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)] [&_svg]:text-muted-foreground"
      >
        <Icon icon={CardsIcon} />
        New deck
        <Kbd keys="shift+mod+n" variant="bare" className="ml-auto" />
      </Link>
      {!ready ? (
        <ListSkeleton label="decks" shape="tile" rows={4} />
      ) : error && !runs.length ? (
        <ViewSidebarError onRetry={retry} />
      ) : !shown.length ? (
        <EmptyState
          icon={CardsIcon}
          title="No decks yet"
          description="A deck splits a goal into cards, deals them to agents and merges the results."
        />
      ) : (
        <nav aria-label="Decks">
          {groups.map((group) => {
            const members = shown.filter((run) => deckGroup(run) === group.id);
            return members.length ? (
              <ViewRowSection key={group.id} label={group.label}>
                {members.map((run) => (
                  <li key={run.id}>
                    <DeckRow run={run} />
                  </li>
                ))}
              </ViewRowSection>
            ) : null;
          })}
        </nav>
      )}
    </ViewSidebar>
  );
}

function DeckRow(props: { run: DeckRun }) {
  return (
    <Link to="/deck/$runId" params={{ runId: props.run.id }} className={viewRowClass}>
      <ViewRowBody
        icon={CardsIcon}
        title={props.run.title}
        description={deckRunSummary(props.run)}
      />
    </Link>
  );
}
