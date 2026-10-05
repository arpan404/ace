import {
  CardsIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  HandPalmIcon,
  HourglassIcon,
  PauseCircleIcon,
  ProhibitIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import {
  ViewRowBody,
  ViewRowSection,
  viewRowClass,
  ViewSidebarError,
} from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { deckGroup, deckRunSummary, formatAge, type DeckRun, type DeckGroup } from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import { useDeckMore, useDeckRetry, useDeckRuns } from "./deck-source.ts";
import { useProjectName } from "@/lib/projects.ts";

const groups: readonly { id: DeckGroup; label: string }[] = [
  { id: "gated", label: "Needs you" },
  { id: "stopped", label: "Stopped" },
  { id: "active", label: "Active" },
  { id: "finished", label: "Finished" },
];

/** The project filter, kept on this device across visits. */
const filterKey = "ace.deck.filter";

function storedFilter(): string {
  try {
    return localStorage.getItem(filterKey) ?? "all";
  } catch {
    return "all";
  }
}

function useProjectFilter(): [string, (value: string) => void] {
  const [value, setValue] = useState(storedFilter);
  return [
    value,
    (next) => {
      setValue(next);
      try {
        localStorage.setItem(filterKey, next);
      } catch {
        // Storage can be full or blocked; the filter still applies for this visit.
      }
    },
  ];
}

/** Deck's list in the sidebar: New deck, then every deck grouped by what it needs. */
export function DeckSidebar() {
  const { ready, error, runs, more } = useDeckRuns();
  const retry = useDeckRetry();
  const older = useDeckMore();
  const [stored, setProject] = useProjectFilter();
  const projectName = useProjectName();
  const projects = [...new Set(runs.map((run) => run.workspaceId))].toSorted();
  // A remembered project with no decks any more shows everything rather than an empty list.
  const project = stored === "all" || projects.includes(stored) || !ready ? stored : "all";
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
        // With no decks at all, the main pane invites the first one; nothing is said twice.
        // WP-1: EmptyState variant="inline" once it lands.
        runs.length > 0 && (
          <p className="px-[11px] pt-3 text-sm text-muted-foreground">
            No decks in {projectName(project)}.
          </p>
        )
      ) : (
        <nav aria-label="Decks">
          {groups.map((group) => {
            const members = shown
              .filter((run) => deckGroup(run) === group.id)
              .toSorted(group.id === "gated" ? longestWaiting : latest);
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
          {more && (
            <button
              type="button"
              onClick={older}
              className="mt-2 px-[11px] rounded-xs text-sm font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:shadow-[0_0_0_2px_var(--ring)]"
            >
              {/* WP-1: focus-ring */}
              Show older decks
            </button>
          )}
        </nav>
      )}
    </ViewSidebar>
  );
}

/** Decks that need you by how long they have waited; the rest by their latest change. */
const longestWaiting = (a: DeckRun, b: DeckRun) => (a.gate?.gatedAt ?? 0) - (b.gate?.gatedAt ?? 0);
const latest = (a: DeckRun, b: DeckRun) => b.updatedAt - a.updatedAt;

/**
 * A deck's state at a glance, in its row's tile.
 * WP-1: a `mark` slot on ViewRowBody would take the live spinner and needs-you dot instead.
 */
function markOf(run: DeckRun): IconGlyph {
  if (run.gate) return HandPalmIcon;
  switch (run.phase) {
    case "merged":
    case "finished":
      return CheckCircleIcon;
    case "cancelled":
    case "stopping":
      return ProhibitIcon;
    case "failed":
      return WarningCircleIcon;
    case "paused":
      return PauseCircleIcon;
    case "waiting":
      return HourglassIcon;
    default:
      return CircleNotchIcon;
  }
}

function DeckRow(props: { run: DeckRun }) {
  const now = useNow();
  const { run } = props;
  const at = run.gate?.gatedAt || run.updatedAt;
  return (
    <Link to="/deck/$runId" params={{ runId: run.id }} className={viewRowClass}>
      <ViewRowBody
        icon={markOf(run)}
        title={run.title}
        strong={!!run.gate}
        description={deckRunSummary(run)}
        meta={at ? formatAge(at, now) : undefined}
      />
    </Link>
  );
}
