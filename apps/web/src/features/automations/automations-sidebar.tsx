import { MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import {
  compactViewRowClass,
  ViewRowSection,
  ViewSidebarError,
  useViewListKeys,
} from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { localTimeZone } from "@/features/automation-schedule/index.ts";
import { sidebarGroups, type SidebarRow } from "./sidebar-rows.ts";
import { useAutomationLists } from "@/features/automation-data/index.ts";

/**
 * Automations as a list of conversations: New automation, then Upcoming (soonest first), Paused,
 * and the ones agents made in threads. Each row is its title over one line of when it runs next,
 * or a status word when it needs a look.
 */
export function AutomationsSidebar() {
  const list = useAutomationLists();
  const selected = useParams({ strict: false }).automationId;
  const now = useNow();
  const keys = useViewListKeys<HTMLElement>();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const groups = list.data ? sidebarGroups(list.data, now, localTimeZone(), query) : undefined;
  const any = !!list.data && list.data.person.length + list.data.threads.length > 0;
  return (
    <ViewSidebar
      title="Automations"
      actions={
        any ? (
          <IconButton
            icon={MagnifyingGlassIcon}
            label="Search automations"
            size="sm"
            aria-pressed={searching}
            onClick={() => {
              if (searching) setQuery("");
              setSearching(!searching);
            }}
          />
        ) : undefined
      }
      toolbar={
        <div className="flex shrink-0 flex-col gap-1 px-2 pb-1">
          {searching && (
            <SearchField
              label="Search automations"
              placeholder="Search automations"
              value={query}
              autoFocus
              onValueChange={setQuery}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !query) setSearching(false);
              }}
              className="bg-sidebar-accent"
            />
          )}
          <Link
            to="/automations/new"
            activeOptions={{ exact: true }}
            activeProps={{ "aria-current": "page" }}
            className={compactViewRowClass}
          >
            <Icon icon={PlusIcon} size={16} className="shrink-0 text-muted-foreground" />
            New automation
          </Link>
        </div>
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
            <ViewRowSection key={group.label} label={group.label}>
              {group.rows.map((row) => (
                <li key={`${row.owner ?? ""}:${row.id}`}>
                  <AutomationRow row={row} selected={selected === row.id} />
                </li>
              ))}
            </ViewRowSection>
          ))}
        </nav>
      )}
    </ViewSidebar>
  );
}

function AutomationRow(props: { row: SidebarRow; selected: boolean }) {
  const { row } = props;
  return (
    <Link
      to="/automations/$automationId"
      params={{ automationId: row.id }}
      aria-current={props.selected ? "page" : undefined}
      data-view-row=""
      className="flex min-h-11 flex-col justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors duration-(--motion-fast) hover:bg-sidebar-accent focus-ring-inset aria-[current=page]:bg-sidebar-accent"
    >
      <span
        data-view-row-title=""
        className={
          row.paused
            ? "min-w-0 truncate text-md text-muted-foreground"
            : "min-w-0 truncate text-md text-foreground"
        }
      >
        {row.title}
      </span>
      <span className="min-w-0 truncate text-meta text-muted-foreground">
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
    </Link>
  );
}
