import {
  spadeActivityKinds,
  spadeActivityKindWords,
  spadeActivityWords,
  spadeWhen,
  type SpadeActivityEntry,
  type SpadeActivityKind,
} from "@ace/ui-core/spade-chat";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { readingColumn } from "@/features/thread/index.ts";
import { useNow } from "@/lib/time.ts";
import { readActivity } from "./spade-oversight-api.ts";
import { personZone } from "./spade-routines-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** Entries per page; "Show older" reads the next. */
const pageSize = 100;

/**
 * A bot's activity (ADR 0135): what it did, newest first, never in the chat. Kinds toggle on and
 * off as words; a day narrows it to the person's day; the search box matches every word. Each
 * row is when, one sentence, what it was about, and how it went and what it cost, muted. "Show
 * older" reads the page before the last entry shown.
 */
export function SpadeActivity(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const ids = { search: useId(), day: useId() };
  const [kinds, setKinds] = useState<readonly SpadeActivityKind[]>([]);
  const [day, setDay] = useState("");
  const [typed, setTyped] = useState("");
  const q = useDeferredValue(typed.trim());
  const activity = useInfiniteQuery({
    queryKey: ["spade", "activity", machine, bot.id, kinds, day, q],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      readActivity(
        client,
        bot.id,
        {
          kinds,
          ...(day ? { day } : {}),
          ...(q ? { q } : {}),
          ...(pageParam === undefined ? {} : { before: pageParam }),
          limit: pageSize,
        },
        signal,
      ),
    getNextPageParam: (page) => (page.more ? page.entries.at(-1)?.seq : undefined),
    // What it did changes while it works.
    refetchInterval: 30_000,
  });
  const entries = activity.data?.pages.flatMap((page) => page.entries) ?? [];
  const filtered = kinds.length > 0 || day !== "" || q !== "";
  const zone = personZone();
  const toggle = (kind: SpadeActivityKind) =>
    setKinds((shown) =>
      shown.includes(kind)
        ? shown.filter((each) => each !== kind)
        : spadeActivityKinds.filter((each) => each === kind || shown.includes(each)),
    );
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      <div className={`${readingColumn} flex flex-col gap-4 py-6`}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={ids.search}
            type="search"
            aria-label="Search activity"
            placeholder="Search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="min-w-40 flex-1"
          />
          <label htmlFor={ids.day} className="sr-only">
            Day
          </label>
          <Input
            id={ids.day}
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="w-40"
          />
          {day && (
            <Button size="sm" variant="ghost" onClick={() => setDay("")}>
              Any day
            </Button>
          )}
        </div>
        <div role="group" aria-label="Kinds" className="-mx-1.5 flex flex-wrap gap-1">
          {spadeActivityKinds.map((kind) => (
            <Button
              key={kind}
              size="xs"
              variant="ghost"
              aria-pressed={kinds.includes(kind)}
              onClick={() => toggle(kind)}
              className="aria-pressed:bg-active aria-pressed:text-foreground"
            >
              {spadeActivityKindWords[kind]}
            </Button>
          ))}
        </div>
        {activity.isPending ? (
          <LoadingRegion label="Activity" className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-2/3 rounded-md" />
          </LoadingRegion>
        ) : activity.isError && !entries.length ? (
          <div role="alert" className="flex items-center gap-2 text-ui text-muted-foreground">
            <span className="min-w-0 flex-1">{activity.error.message}</span>
            <Button size="xs" variant="ghost" onClick={() => void activity.refetch()}>
              Try again
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <p className="text-ui text-muted-foreground">
            {filtered ? "Nothing matches." : `${bot.name} hasn't done anything yet.`}
          </p>
        ) : (
          <ol aria-label="Activity" className="flex flex-col">
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} now={now} zone={zone} />
            ))}
          </ol>
        )}
        {activity.hasNextPage && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            disabled={activity.isFetchingNextPage}
            onClick={() => void activity.fetchNextPage()}
          >
            {activity.isFetchingNextPage ? "Reading…" : "Show older"}
          </Button>
        )}
      </div>
    </div>
  );
}

function Row(props: { entry: SpadeActivityEntry; now: number; zone: string }) {
  const words = spadeActivityWords(props.entry);
  return (
    <li className="flex min-w-0 gap-3 py-2">
      <span className="w-24 shrink-0 text-meta text-subtle-foreground tabular-nums">
        {spadeWhen(props.entry.at, props.now, props.zone)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui text-foreground">{words.sentence}</span>
        {words.detail && (
          <span className="truncate text-xs text-muted-foreground" title={words.detail}>
            {words.detail}
          </span>
        )}
      </span>
      {words.facts && (
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{words.facts}</span>
      )}
    </li>
  );
}
