import { ArrowSquareOutIcon, ClockCounterClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { addressHost, displayAddress } from "@ace/ui-core";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { cn } from "@/lib/cn.ts";
import { searchVisits, useBrowsingHistory, useVisits, type Visit } from "./browsing-history.ts";

/** "Today", "Yesterday" or the date, for a day's heading. */
function dayLabel(at: number, now: number): string {
  const day = new Date(at).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The thread's browsing history, newest first and grouped by day, searchable by title and
 * address. A visit opens in the shown tab; its icon opens it in a new tab. Visits are kept on
 * this device.
 */
export function HistoryDialog(props: {
  threadId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpen(url: string): void;
  onOpenTab(url: string): void;
  /** When the dialog was opened, for the day headings. */
  now: number;
}) {
  const visits = useVisits(props.threadId);
  const history = useBrowsingHistory();
  const [query, setQuery] = useState("");
  const found = useMemo(() => searchVisits(visits, query), [visits, query]);
  const days = useMemo(() => {
    const groups: { label: string; visits: Visit[] }[] = [];
    for (const visit of found) {
      const label = dayLabel(visit.at, props.now);
      const last = groups.at(-1);
      if (last?.label === label) last.visits.push(visit);
      else groups.push({ label, visits: [visit] });
    }
    return groups;
  }, [found, props.now]);
  const open = (url: string) => {
    props.onOpenChange(false);
    props.onOpen(url);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="lg" className="h-[min(640px,calc(100vh-4rem))]">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
        </DialogHeader>
        <Input
          aria-label="Search history"
          placeholder="Search history"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <DialogBody className="gap-3">
          {days.length === 0 ? (
            <EmptyState
              icon={ClockCounterClockwiseIcon}
              title={visits.length ? "No matches" : "No history yet"}
              description={
                visits.length
                  ? "Try another word from the page's title or address."
                  : "Pages this thread's browser shows you are listed here."
              }
            />
          ) : (
            days.map((day) => (
              <section key={day.label} aria-label={day.label} className="flex flex-col">
                <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{day.label}</h3>
                <ul className="flex flex-col">
                  {day.visits.map((visit) => (
                    <li
                      key={`${visit.at}:${visit.url}`}
                      className="group flex h-9 items-center gap-2 rounded-md pr-1 pl-2 hover:bg-accent"
                    >
                      <span className="w-14 shrink-0 text-xs text-subtle-foreground tabular-nums">
                        {time(visit.at)}
                      </span>
                      <button
                        type="button"
                        onClick={() => open(visit.url)}
                        className="flex min-w-0 flex-1 items-baseline gap-2 text-left outline-none focus-ring-inset"
                      >
                        <span className="truncate text-ui text-foreground">
                          {visit.title || displayAddress(visit.url)}
                        </span>
                        <span className="shrink-0 truncate text-xs text-subtle-foreground">
                          {addressHost(visit.url)}
                        </span>
                      </button>
                      <span
                        className={cn(
                          "flex shrink-0 items-center opacity-0 transition-opacity duration-(--motion-fast)",
                          "group-focus-within:opacity-100 group-hover:opacity-100",
                        )}
                      >
                        <IconButton
                          icon={ArrowSquareOutIcon}
                          label={`Open ${displayAddress(visit.url)} in a new tab`}
                          tip="Open in new tab"
                          size="sm"
                          onClick={() => {
                            props.onOpenChange(false);
                            props.onOpenTab(visit.url);
                          }}
                        />
                        <IconButton
                          icon={XIcon}
                          label={`Remove ${displayAddress(visit.url)} from history`}
                          tip="Remove from history"
                          size="sm"
                          onClick={() => history.remove(props.threadId, visit)}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
