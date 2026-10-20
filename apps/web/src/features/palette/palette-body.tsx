import {
  ArrowRightIcon,
  ChatCircleIcon,
  CheckIcon,
  FolderSimpleIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
} from "@phosphor-icons/react";
import { useParams } from "@tanstack/react-router";
import { useClient } from "@ace/client-react";
import { matchRanges } from "@ace/ui-core/command-rank";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.tsx";
import { closeHint, KeyHints, navigateHint, selectHint } from "@/components/ui/key-hints.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { cn } from "@/lib/cn.ts";
import { searchSettleMs } from "@/lib/debounced.ts";
import { warmThread } from "@/lib/thread-warmer.ts";
import { resolveKeys, useResolvedKeymap } from "@/lib/keybindings.ts";
import { describeKeys } from "@/lib/keymap.ts";
import { useLayout, type PalettePage } from "@/lib/layout.tsx";
import { arrange, readQuery, type Row, type RowGroup } from "./arrange.ts";
import { usePaletteGroups, type PaletteCommand } from "./commands.ts";
import { useMessageHits } from "./message-hits.ts";
import { readRecentCommands, readRecentThreads, recentShown, rememberCommand } from "./recent.ts";

const icons = {
  thread: ChatCircleIcon,
  project: FolderSimpleIcon,
  view: ArrowRightIcon,
  action: LightningIcon,
  settle: CheckIcon,
  theme: PaletteIcon,
} as const;

const wallClock = () => Date.now();

/** Text with the given [start, end) ranges in full ink. */
function Marked(props: { text: string; ranges: readonly (readonly [number, number])[] }) {
  if (!props.ranges.length) return props.text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of props.ranges) {
    if (start < at) continue;
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
export default function PaletteBody(props: { close(): void; push(page: PalettePage): void }) {
  const keymap = useResolvedKeymap();
  const phone = usePhone();
  const current = useParams({ strict: false }).threadId;
  const { storage, openSearch } = useLayout();
  const [query, setQuery] = useState("");
  const groups = usePaletteGroups(props.close, query, props.push);
  const messages = useMessageHits(query, props.close);
  const [recentThreads] = useState(() => readRecentThreads(storage));
  const [recentCommands] = useState(() => readRecentCommands(storage));
  const searchAll = useCallback(
    (text: string): PaletteCommand => ({
      id: "search-all",
      label: `Search all threads for “${text}”`,
      kind: "message",
      icon: MagnifyingGlassIcon,
      // Opening search closes the palette: one sheet at a time.
      run: () => openSearch(text),
    }),
    [openSearch],
  );
  const rows = useMemo(
    () =>
      arrange({
        groups,
        query,
        recentThreads,
        recentCommands,
        current,
        messages,
        searchAll,
        recentLimit: recentShown,
      }),
    [groups, query, recentThreads, recentCommands, current, messages, searchAll],
  );
  const { text } = readQuery(query);
  const ranked = query.trim() !== "";
  const client = useClient();
  const warmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(warmTimer.current), []);
  // Typing moves the highlight on every key; only the row it settles on is followed.
  const warm = useCallback(
    (item: Row | undefined) => {
      clearTimeout(warmTimer.current);
      const threadId = item?.threadId;
      if (threadId)
        warmTimer.current = setTimeout(() => warmThread(client, threadId), searchSettleMs);
    },
    [client],
  );
  const run = (item: Row) => {
    if (item.kind === undefined) rememberCommand(storage, item.id, wallClock());
    item.run();
  };
  return (
    <Command
      items={rows}
      itemToStringValue={(item: Row) => item.label}
      filter={null}
      value={query}
      onValueChange={setQuery}
      onItemHighlighted={warm}
    >
      <CommandInput
        aria-label="Search commands"
        placeholder={phone ? "Search or run a command" : "Search threads, projects and commands"}
      />
      <CommandEmpty>No commands or threads match.</CommandEmpty>
      <CommandList>
        {(group: RowGroup) => (
          <CommandGroup key={group.value} items={group.items}>
            <CommandGroupLabel className={cn(ranked && !group.labelled && "sr-only")}>
              {group.value}
            </CommandGroupLabel>
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
                    onClick={() => run(item)}
                    className={cn(item.danger && "text-destructive [&_svg]:text-destructive")}
                  >
                    <Glyph
                      aria-hidden
                      style={item.tint ? { color: `var(--project-${item.tint})` } : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      <span className={cn(!ranked && "text-foreground")}>
                        <Marked
                          text={item.label}
                          ranges={ranked ? matchRanges(text, item.label) : []}
                        />
                      </span>
                      {item.snippet ? (
                        <span className="ml-1.5 text-sm text-muted-foreground">
                          <Marked
                            text={item.snippet.text}
                            ranges={item.snippet.highlights.map(
                              (range) => [range.start, range.end] as const,
                            )}
                          />
                        </span>
                      ) : (
                        detail && (
                          <span className="ml-1.5 text-sm text-muted-foreground">
                            {detail}
                            {item.more && (
                              <span className="hidden in-data-highlighted:inline">
                                {" "}
                                · {item.more}
                              </span>
                            )}
                          </span>
                        )
                      )}
                    </span>
                    {ranked && item.hint && !group.labelled && (
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
      {!phone && <KeyHints hints={[navigateHint, selectHint, closeHint]} />}
    </Command>
  );
}
