import { spadeActivityRow, spadeWhen, type SpadeActivityEntry } from "@ace/ui-core/spade-chat";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { readActivity } from "./spade-oversight-api.ts";
import { personZone } from "./spade-routines-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileEmpty, ProfileProblem, rowPill } from "./spade-profile-parts.tsx";
import { SettingCard } from "@/components/setting-row.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** Entries per page; Show older reads the next. */
const pageSize = 50;

/**
 * What the bot did (ADR 0135), newest first, never in the chat: each row is Spade's sentence with
 * its detail under it, and when it happened at the right. Only an exception takes the time's
 * place, in its colour: what failed, was refused or waits on the person. Show older reads the
 * page before the last entry shown.
 */
export function SpadeActivity(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const activity = useInfiniteQuery({
    queryKey: ["spade", "activity", machine, bot.id, "profile"],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      readActivity(
        client,
        bot.id,
        { ...(pageParam === undefined ? {} : { before: pageParam }), limit: pageSize },
        signal,
      ),
    getNextPageParam: (page) => page.nextBefore,
    // What it did changes while it works.
    refetchInterval: 30_000,
  });
  const entries = activity.data?.pages.flatMap((page) => page.entries) ?? [];
  const zone = personZone();
  return (
    <div className="flex flex-col gap-2">
      <SettingCard>
        {activity.isPending ? (
          <ListSkeleton label="activity" shape="row" rows={3} />
        ) : activity.isError && !entries.length ? (
          <ProfileProblem
            text="Couldn't read what it did."
            onRetry={() => void activity.refetch()}
          />
        ) : entries.length === 0 ? (
          <ProfileEmpty>
            {activity.hasNextPage
              ? "Nothing in the most recent part of its history."
              : `${bot.name} hasn't done anything yet.`}
          </ProfileEmpty>
        ) : (
          <ol
            aria-label="Activity"
            data-setting-slot=""
            className="flex flex-col divide-y divide-border-soft"
          >
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} now={now} zone={zone} />
            ))}
          </ol>
        )}
      </SettingCard>
      {activity.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          className={cn(rowPill, "self-start")}
          disabled={activity.isFetchingNextPage}
          onClick={() => void activity.fetchNextPage()}
        >
          {activity.isFetchingNextPage ? "Reading…" : "Show older"}
        </Button>
      )}
    </div>
  );
}

const tones = {
  failed: "text-(--status-failed-text)",
  needs: "text-(--status-needs-you-text)",
  quiet: "text-subtle-foreground",
} as const;

function Row(props: { entry: SpadeActivityEntry; now: number; zone: string }) {
  const row = spadeActivityRow(props.entry);
  const when = spadeWhen(props.entry.at, props.now, props.zone);
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2.5">
      <span className="text-ui text-foreground">{row.sentence}</span>
      <span
        className={cn(
          "text-right text-xs leading-5 whitespace-nowrap tabular-nums",
          row.exception ? tones[row.exception.tone] : "text-subtle-foreground",
        )}
        title={row.exception ? when : undefined}
      >
        {row.exception?.words ?? when}
      </span>
      {row.detail && (
        <span className="col-start-1 truncate text-xs text-subtle-foreground" title={row.detail}>
          {row.detail}
        </span>
      )}
    </li>
  );
}
