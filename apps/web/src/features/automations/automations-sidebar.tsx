import { PlusIcon } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  panelIconButton,
  panelLabel,
  PanelNoMatch,
  PanelRowBody,
  panelRow,
} from "@/components/ui/panel.tsx";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { ViewSidebarError, useViewListKeys } from "@/components/ui/view-row.tsx";
import { VirtualList, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { localTimeZone } from "@/features/automation-schedule/index.ts";
import { sidebarGroups, type SidebarRow } from "@ace/ui-core/automations";
import { useAutomationLists } from "@/features/automation-data/index.ts";

/** One row of the panel's list: a section's label, or an automation under it. */
type ListRow = { kind: "label"; label: string; first: boolean } | { kind: "row"; row: SidebarRow };

const rowKey = (entry: ListRow) =>
  entry.kind === "label" ? `label:${entry.label}` : `${entry.row.owner ?? ""}:${entry.row.id}`;

/** A label is a 28px line with the gap above it; a row is one `--row-height` line and 1px. */
const estimateOf = (entry: ListRow) => (entry.kind === "row" ? 37 : entry.first ? 32 : 48);

/**
 * Automations' panel: its title row (New automation, then the magnifier that opens "Search
 * automations" in place once there is one), then Upcoming (soonest first), Paused, and the ones
 * agents made in threads. Each row is one line:
 * its title, then a status word when it needs a look and when it runs next.
 */
export function AutomationsSidebar() {
  const list = useAutomationLists();
  const selected = useParams({ strict: false }).automationId;
  const now = useNow();
  const [query, setQuery] = useState("");
  const groups = list.data ? sidebarGroups(list.data, now, localTimeZone(), query) : undefined;
  const rows: ListRow[] = [];
  for (const group of groups ?? []) {
    rows.push({ kind: "label", label: group.label, first: !rows.length });
    for (const row of group.rows) rows.push({ kind: "row", row });
  }
  const handle = useRef<VirtualRowsHandle>(null);
  const keys = useViewListKeys<HTMLElement>({
    count: rows.length,
    titleAt: (index) => {
      const entry = rows[index];
      return entry?.kind === "row" ? entry.row.title : undefined;
    },
    reveal: (index) => handle.current?.scrollToIndex(index, "auto"),
  });
  const any = !!list.data && list.data.person.length + list.data.threads.length > 0;
  return (
    <ViewSidebar
      title="Automations"
      actions={<NewAutomationButton />}
      {...(any ? { search: { label: "Search automations", query, onQuery: setQuery } } : {})}
    >
      {!list.data && list.isError ? (
        <ViewSidebarError onRetry={() => void list.refetch()} />
      ) : !groups ? (
        <ListSkeleton label="automations" shape="row" rows={4} />
      ) : !groups.length && query.trim() ? (
        <PanelNoMatch>No automations match.</PanelNoMatch>
      ) : (
        <nav {...keys} aria-label="Automation list">
          <VirtualList
            label="Automations"
            items={rows}
            handle={handle}
            rowKey={rowKey}
            estimate={estimateOf}
            render={(entry) =>
              entry.kind === "label" ? (
                <h3 className={cn(panelLabel, "box-content", entry.first ? "pt-1" : "pt-5")}>
                  {entry.label}
                </h3>
              ) : (
                <div className="pb-px">
                  <AutomationRow row={entry.row} selected={selected === entry.row.id} />
                </div>
              )
            }
          />
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

/** New automation, the + in the title row, as Skills' Add and Threads' New thread sit there. */
function NewAutomationButton() {
  return (
    <Tip label="New automation">
      <Link
        to="/automations/new"
        aria-label="New automation"
        activeOptions={{ exact: true }}
        activeProps={{ "aria-current": "page" }}
        className={cn(
          panelIconButton,
          "aria-[current=page]:bg-active aria-[current=page]:text-foreground",
        )}
      >
        <Icon icon={PlusIcon} size={18} />
      </Link>
    </Tip>
  );
}
