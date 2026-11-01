import { PlusIcon } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { PanelRowBody, panelRow, PanelSearch, PanelSection } from "@/components/ui/panel.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { ViewSidebarError, useViewListKeys } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { localTimeZone } from "@/features/automation-schedule/index.ts";
import { sidebarGroups, type SidebarRow } from "@ace/ui-core/automations";
import { useAutomationLists } from "@/features/automation-data/index.ts";

/**
 * Automations' panel: its title, "Search automations" once there is one, New automation, then
 * Upcoming (soonest first), Paused, and the ones agents made in threads. Each row is one line:
 * its title, then a status word when it needs a look and when it runs next.
 */
export function AutomationsSidebar() {
  const list = useAutomationLists();
  const selected = useParams({ strict: false }).automationId;
  const now = useNow();
  const keys = useViewListKeys<HTMLElement>();
  const [query, setQuery] = useState("");
  const groups = list.data ? sidebarGroups(list.data, now, localTimeZone(), query) : undefined;
  const any = !!list.data && list.data.person.length + list.data.threads.length > 0;
  return (
    <ViewSidebar
      title="Automations"
      toolbar={
        <>
          {any && (
            <PanelSearch
              label="Search automations"
              placeholder="Search automations"
              value={query}
              onValueChange={setQuery}
            />
          )}
          <div className="shrink-0 px-2 pb-1">
            <Link
              to="/automations/new"
              activeOptions={{ exact: true }}
              activeProps={{ "aria-current": "page" }}
              {...panelRow()}
            >
              <PanelRowBody icon={PlusIcon} title="New automation" />
            </Link>
          </div>
        </>
      }
    >
      {!list.data && list.isError ? (
        <ViewSidebarError onRetry={() => void list.refetch()} />
      ) : !groups ? (
        <ListSkeleton label="automations" shape="row" rows={4} />
      ) : !groups.length && query.trim() ? (
        <EmptyState
          variant="inline"
          title="No matching automations"
          description={`Nothing matches "${query.trim()}".`}
          action={
            <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <nav {...keys} aria-label="Automation list">
          {groups.map((group) => (
            <PanelSection key={group.label} label={group.label}>
              {group.rows.map((row) => (
                <li key={`${row.owner ?? ""}:${row.id}`}>
                  <AutomationRow row={row} selected={selected === row.id} />
                </li>
              ))}
            </PanelSection>
          ))}
        </nav>
      )}
    </ViewSidebar>
  );
}

/** One automation on one line: its title, then its status word and when it runs, quieter. */
function AutomationRow(props: { row: SidebarRow; selected: boolean }) {
  const { row } = props;
  const meta = `${row.status ? `${row.status.word} · ` : ""}${row.detail}`;
  return (
    <Link
      to="/automations/$automationId"
      params={{ automationId: row.id }}
      aria-current={props.selected ? "page" : undefined}
      title={`${row.title}\n${meta}`}
      {...panelRow()}
    >
      <PanelRowBody
        title={row.title}
        quiet={row.paused}
        trailing={
          <span className="max-w-[45%] shrink-0 truncate text-meta text-muted-foreground">
            {row.status &&
              (row.status.tone === "idle" ? (
                row.status.word
              ) : (
                <span data-tone={row.status.tone} className="font-medium text-(--tone-text)">
                  {row.status.word}
                </span>
              ))}
            {row.status && " · "}
            {row.detail}
          </span>
        }
      />
    </Link>
  );
}
