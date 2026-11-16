import { formatClock } from "@ace/ui-core/time";
import { spadeMoney, type SpadeEpisode } from "@ace/ui-core/spade-chat";
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingList } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/lib/time.ts";
import { knowledgeKey, readEpisode, readEpisodes } from "./spade-knowledge-api.ts";
import { DocTop, LibraryRow, dayWords, leading } from "./spade-library-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileEmpty, ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** Past work shown before Show all. */
const shownEpisodes = 5;

const outcomeWords: Record<SpadeEpisode["outcome"], string> = {
  verified: "Done and checked",
  ended: "Ended",
  failed: "Ended as failed",
};

/** The line under a piece of past work in a list: what it came to. */
export const episodeLine = (episode: SpadeEpisode) =>
  episode.note ?? (episode.text || outcomeWords[episode.outcome]);

/** Newest closed first. */
export const newestClosed = (episodes: SpadeEpisode[]) =>
  episodes.toSorted((a, b) => b.closedAt - a.closedAt);

/** Past work: a summary per goal the bot closed, newest first; one opens in the Library's place. */
export function LibraryPast(props: { bot: RosterBot; onOpen(id: string): void }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const [all, setAll] = useState(false);
  const past = useQuery({
    queryKey: [...knowledgeKey, machine, bot.id, "episodes", ""],
    queryFn: ({ signal }) => readEpisodes(client, bot.id, { signal }),
  });
  const episodes = newestClosed(past.data ?? []);
  const shown = all ? episodes : episodes.slice(0, shownEpisodes);
  return (
    <ProfileSection
      label="Past work"
      actions={
        episodes.length > shownEpisodes && (
          <Button size="sm" variant="ghost" className={rowPill} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `All ${episodes.length}`}
          </Button>
        )
      }
    >
      {past.isPending ? (
        <ListSkeleton label="past work" shape="row" rows={2} />
      ) : past.isError && !past.data ? (
        <ProfileProblem text="Couldn't read the past work." onRetry={() => void past.refetch()} />
      ) : episodes.length === 0 ? (
        <ProfileEmpty>{`Each goal ${bot.name} finishes is kept here.`}</ProfileEmpty>
      ) : (
        <SettingList aria-label={`${bot.name}'s past work`}>
          {shown.map((episode) => (
            <LibraryRow
              key={episode.id}
              title={episode.title}
              line={episodeLine(episode)}
              at={episode.closedAt}
              now={now}
              onOpen={() => props.onOpen(episode.id)}
            />
          ))}
        </SettingList>
      )}
    </ProfileSection>
  );
}

/** "Today, 10:20 AM – 1:48 PM", or across days "Nov 12 – Nov 13". */
function spanWords(from: number, to: number, now: number) {
  const start = dayWords(from, now);
  const end = dayWords(to, now);
  if (start !== end) return `${leading(start)} – ${end}`;
  return `${leading(start)}, ${formatClock(from)} – ${formatClock(to)}`;
}

/**
 * A piece of past work, open in the Library's place: the goal in its words, when it ran, how it
 * closed and what it cost, then what it had to meet, what worked, what didn't and why, what was
 * still missing, and the bot's own last word on it.
 */
export function LibraryEpisode(props: { bot: RosterBot; id: string; onBack(): void }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const read = useQuery({
    queryKey: [...knowledgeKey, machine, "episode", props.id],
    queryFn: ({ signal }) => readEpisode(client, props.id, signal),
  });
  if (!read.data)
    return (
      <>
        <DocTop onBack={props.onBack} />
        {read.isPending ? (
          <div aria-hidden className="h-7 w-2/3 rounded-md bg-hover" />
        ) : (
          <ProfileProblem text="Couldn't read it." onRetry={() => void read.refetch()} />
        )}
      </>
    );
  const episode = read.data;
  const meta = [
    spanWords(episode.startedAt, episode.closedAt, now),
    outcomeWords[episode.outcome],
    ...(episode.costMicros > 0 ? [spadeMoney(episode.costMicros)] : []),
  ].join(" · ");
  return (
    <article aria-label={episode.title} className="flex flex-col">
      <DocTop onBack={props.onBack} />
      <h3 className="text-lg leading-7 font-semibold text-foreground">{episode.title}</h3>
      <p className="mt-1 text-xs leading-[18px] text-subtle-foreground tabular-nums">
        {meta}
        {episode.untrusted && <span className="text-muted-foreground">{" · Untrusted"}</span>}
      </p>
      {episode.text && (
        <p className="mt-4 text-md leading-[22px] text-foreground">{episode.text}</p>
      )}
      {episode.criteria.length > 0 && (
        <Part label="Done when">
          {episode.criteria.map((criterion) => (
            <li key={criterion.text} className="flex gap-2">
              <span className="mt-0.5 size-4 shrink-0 text-muted-foreground">
                {criterion.met === true ? (
                  <Icon icon={CheckIcon} size={16} label="Met" />
                ) : criterion.met === false ? (
                  <Icon icon={XIcon} size={16} label="Not met" />
                ) : null}
              </span>
              {criterion.text}
            </li>
          ))}
        </Part>
      )}
      {episode.worked.length > 0 && (
        <Part label="Worked">
          {episode.worked.map((item) => (
            <li key={item.text}>{item.text}</li>
          ))}
        </Part>
      )}
      {episode.failed.length > 0 && (
        <Part label="Didn't work">
          {episode.failed.map((item) => (
            <li key={item.text}>
              {item.text}
              {item.why && <span className="text-muted-foreground">{` · ${item.why}`}</span>}
            </li>
          ))}
        </Part>
      )}
      {episode.missing.length > 0 && (
        <Part label="Still missing">
          {episode.missing.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </Part>
      )}
      {episode.note && (
        <Part
          label={`In ${/s$/i.test(props.bot.name) ? `${props.bot.name}'` : `${props.bot.name}'s`} words`}
        >
          <li className="text-muted-foreground">{episode.note}</li>
        </Part>
      )}
    </article>
  );
}

function Part(props: { label: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h4 className="mb-1.5 text-ui font-medium text-muted-foreground">{props.label}</h4>
      <ul className="flex flex-col gap-1.5 text-ui text-foreground">{props.children}</ul>
    </section>
  );
}
