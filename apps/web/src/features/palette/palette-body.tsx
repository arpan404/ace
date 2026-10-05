import {
  ArrowRightIcon,
  ChatCircleIcon,
  CheckIcon,
  FolderSimpleIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { matchRanges, rankCommand } from "@ace/ui-core/command-rank";
import { useMemo, useState, type ReactNode } from "react";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { cn } from "@/lib/cn.ts";
import { resolveKeys, useResolvedKeymap } from "@/lib/keybindings.ts";
import { describeKeys } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { usePaletteGroups, type PaletteCommand, type PaletteGroup } from "./commands.ts";
import { readRecentThreads } from "./recent.ts";

const icons = {
  thread: ChatCircleIcon,
  project: FolderSimpleIcon,
  view: ArrowRightIcon,
  action: LightningIcon,
  settle: CheckIcon,
  theme: PaletteIcon,
} as const;

/** Threads shown before "Show all threads…" with an empty query, and ranked ones with a query. */
const threadsShown = 8;
const threadMatches = 30;

interface Row extends PaletteCommand {
  /** The group it came from, shown at the right of a ranked list. */
  hint?: string;
}
interface RowGroup {
  value: string;
  items: Row[];
}

const isThread = (item: PaletteCommand) => item.id.startsWith("thread-") && item.icon === "thread";

/** The rows to show: Home-like groups for an empty query, one ranked list for a query. */
function arrange(
  groups: PaletteGroup[],
  query: string,
  recent: readonly { id: string; at: number }[],
  allThreads: boolean,
  showAllThreads: () => void,
  searchAll: (query: string) => void,
): RowGroup[] {
  const q = query.trim();
  const threads = groups.find((group) => group.value === "Threads")?.items ?? [];
  const opened = new Map(recent.map((entry) => [`thread-${entry.id}`, entry.at]));
  if (!q) {
    const byId = new Map(threads.map((item) => [item.id, item]));
    const recentRows = recent.flatMap((entry) => byId.get(`thread-${entry.id}`) ?? []).slice(0, 5);
    const out: RowGroup[] = [];
    for (const group of groups) {
      if (group.value === "Threads") {
        const capped = allThreads ? group.items : group.items.slice(0, threadsShown);
        const more =
          !allThreads && group.items.length > threadsShown
            ? [
                {
                  id: "threads-show-all",
                  label: `Show all ${group.items.length} threads…`,
                  icon: "thread" as const,
                  stay: true,
                  run: showAllThreads,
                },
              ]
            : [];
        out.push({ value: group.value, items: [...capped, ...more] });
      } else out.push(group);
      // Recently opened threads sit right after what acts on this thread.
      if (group.value === "This thread" && recentRows.length)
        out.push({ value: "Recent threads", items: recentRows });
    }
    if (!groups.some((group) => group.value === "This thread") && recentRows.length)
      out.unshift({ value: "Recent threads", items: recentRows });
    return out;
  }
  const now = Date.now();
  const scored: { row: Row; score: number }[] = [];
  const seen = new Set<string>();
  for (const group of groups)
    for (const item of group.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const score = rankCommand(
        q,
        {
          label: item.label,
          extra: [item.detail, item.more, item.id].filter(Boolean).join(" "),
          command: !isThread(item) && item.icon !== "project",
          openedAt: opened.get(item.id),
        },
        now,
      );
      if (score !== null) scored.push({ row: { ...item, hint: group.value }, score });
    }
  scored.sort((a, b) => b.score - a.score);
  let threadCount = 0;
  const rows = scored
    .filter(({ row }) => !isThread(row) || ++threadCount <= threadMatches)
    .map(({ row }) => row);
  rows.push({
    id: "search-all",
    label: `Search all threads for “${q}”`,
    icon: MagnifyingGlassIcon,
    run: () => searchAll(q),
  });
  return [{ value: "Results", items: rows }];
}

/** The label with the query's matched letters in full ink. */
function Highlighted(props: { text: string; query: string }) {
  const ranges = props.query ? matchRanges(props.query, props.text) : [];
  if (!ranges.length) return props.text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(props.text.slice(at, start));
    parts.push(
      <span key={start} className="font-medium text-foreground">
        {props.text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  parts.push(props.text.slice(at));
  return parts;
}

/** Mounted only while open, so its list subscriptions end when the palette closes. */
export default function PaletteBody(props: { close(): void }) {
  const groups = usePaletteGroups(props.close);
  const keymap = useResolvedKeymap();
  const phone = usePhone();
  const navigate = useNavigate();
  const { storage } = useLayout();
  const [query, setQuery] = useState("");
  const [allThreads, setAllThreads] = useState(false);
  const [recent] = useState(() => readRecentThreads(storage));
  const rows = useMemo(
    () =>
      arrange(
        groups,
        query,
        recent,
        allThreads,
        () => setAllThreads(true),
        (q) => {
          props.close();
          void navigate({ to: "/more/search", search: { q } });
        },
      ),
    [groups, query, recent, allThreads, props, navigate],
  );
  const ranked = query.trim() !== "";
  return (
    <Command
      items={rows}
      itemToStringValue={(item: Row) => item.label}
      filter={null}
      value={query}
      onValueChange={setQuery}
    >
      <CommandInput
        aria-label="Search commands"
        placeholder={
          phone ? "Search or run a command" : "Search threads, jump to a view, run a command…"
        }
      />
      <CommandEmpty>No commands or threads match.</CommandEmpty>
      <CommandList>
        {(group: RowGroup) => (
          <CommandGroup key={group.value} items={group.items}>
            <CommandGroupLabel className={cn(ranked && "sr-only")}>{group.value}</CommandGroupLabel>
            <CommandCollection>
              {(item: Row) => {
                const Glyph = typeof item.icon === "string" ? icons[item.icon] : item.icon;
                const keys = item.keys && resolveKeys(item.keys, keymap);
                const detail = item.disabled ?? item.detail;
                return (
                  <CommandItem
                    key={item.id}
                    value={item}
                    disabled={item.disabled !== undefined}
                    onClick={item.run}
                    className={cn(item.danger && "text-destructive [&_svg]:text-destructive")}
                  >
                    <Glyph aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      <span className={cn(!ranked && "text-foreground")}>
                        <Highlighted text={item.label} query={ranked ? query : ""} />
                      </span>
                      {detail && (
                        <span className="ml-1.5 text-sm text-muted-foreground">
                          {detail}
                          {item.more && (
                            <span className="hidden in-data-highlighted:inline">
                              {" "}
                              · {item.more}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    {ranked && item.hint && (
                      <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                        {item.hint}
                      </span>
                    )}
                    {keys && !phone && <CommandShortcut>{describeKeys(keys)}</CommandShortcut>}
                  </CommandItem>
                );
              }}
            </CommandCollection>
          </CommandGroup>
        )}
      </CommandList>
      {!phone && <CommandFooter />}
    </Command>
  );
}
