import {
  spadeToolWords,
  type SpadeDecision,
  type SpadeEntry,
  type SpadeEvidence,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { readActivity } from "./spade-oversight-api.ts";
import { pillButton, ProfileProblem } from "./spade-profile-parts.tsx";
import { endGoal } from "./spade-work-api.ts";
import { WorkGoal, WorkPlan } from "./spade-work-goal.tsx";
import { WorkDecisions, WorkWorkers } from "./spade-work-workers.tsx";
import { workKey, type SpadeWork } from "./use-spade-work.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** What Work needs from the conversation beside it. */
export interface ProfileWorkPlace {
  /** The conversation's entries, where each piece of evidence's call is. */
  entries: readonly SpadeEntry[];
  roster: readonly RosterBot[];
  /** Change on a decision: quoted into the composer. */
  onChange(decision: SpadeDecision): void;
  /** A file the plan names, opened in Computer's Files. */
  onOpenFile(path: string): void;
  /** A command's output, in Computer's Activity. */
  onOpenActivity(): void;
}

/** Each call in the conversation by id: its tool and the `seq` its activity entry is filed at. */
function callsIn(entries: readonly SpadeEntry[]) {
  const calls = new Map<string, { name: string; logged: number | undefined }>();
  for (const entry of entries) {
    if (entry.kind !== "reply") continue;
    for (const part of entry.parts)
      if (part.kind === "call") calls.set(part.key, { name: part.name, logged: part.logged });
  }
  return calls;
}

/**
 * What the plan's evidence says in words: a command's own line from the activity log ("gh pr
 * checks 2081"), else what the tool did; a file's path; a link's address.
 */
function useEvidenceWords(bot: RosterBot, entries: readonly SpadeEntry[], wanted: boolean) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const calls = useMemo(() => (wanted ? callsIn(entries) : new Map()), [entries, wanted]);
  const activity = useQuery({
    queryKey: ["spade", "activity", machine, bot.id, "evidence"],
    queryFn: ({ signal }) =>
      readActivity(client, bot.id, { kinds: ["tool", "connector", "file"], limit: 200 }, signal),
    enabled: wanted,
    staleTime: 30_000,
  });
  const details = useMemo(
    () =>
      new Map(
        (activity.data?.entries ?? []).map((entry) => [entry.seq, entry.detail ?? entry.sentence]),
      ),
    [activity.data],
  );
  return (evidence: SpadeEvidence): string => {
    if (evidence.kind === "file") return evidence.path;
    if (evidence.kind === "url") return evidence.url.replace(/^https?:\/\//, "");
    const call = calls.get(evidence.call);
    const detail = call?.logged === undefined ? undefined : details.get(call.logged);
    return detail ?? (call ? spadeToolWords(call.name).done : "A command's output");
  };
}

/**
 * Work: the goal the bot works toward with each criterion's verdict, the plan with evidence, the
 * workers it runs and what it decided for the person. Only the person changes the goal; End goal
 * sits at the foot.
 */
export function ProfileWork(props: { bot: RosterBot; work: SpadeWork; place: ProfileWorkPlace }) {
  const { bot, place, work } = props;
  const goal = work.goal;
  const words = useEvidenceWords(
    bot,
    place.entries,
    goal?.items.some((item) => item.evidence.some((each) => each.kind === "output")) === true,
  );
  if (work.pending) return <ListSkeleton label="work" shape="row" rows={3} />;
  if (work.task.isError && work.tree.isError)
    return (
      <ProfileProblem
        text="Spade didn't answer with this bot's work."
        onRetry={() => {
          void work.task.refetch();
          void work.tree.refetch();
        }}
      />
    );
  return (
    <>
      {goal && <WorkGoal bot={bot} task={goal} />}
      {goal && (
        <WorkPlan
          task={goal}
          evidenceWords={words}
          onEvidence={(evidence) => {
            if (evidence.kind === "file") place.onOpenFile(evidence.path);
            else if (evidence.kind === "url")
              window.open(evidence.url, "_blank", "noopener,noreferrer");
            else place.onOpenActivity();
          }}
        />
      )}
      <WorkWorkers bot={bot} tree={work.tree.data} rows={work.rows} roster={place.roster} />
      <WorkDecisions decisions={work.decisions} onChange={place.onChange} />
      {goal && goal.goal.closed === undefined && <EndGoal bot={bot} />}
    </>
  );
}

function EndGoal(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const [ending, setEnding] = useState(false);
  return (
    <div className="mt-6 -ml-3.5 flex">
      <Button
        variant="ghost"
        tone="danger"
        disabled={ending}
        className={cn(pillButton)}
        onClick={() => {
          setEnding(true);
          void endGoal(client, bot.id)
            .then(() => cache.invalidateQueries({ queryKey: workKey(bot) }))
            .catch((error: unknown) =>
              toast.error({
                title: "Couldn't end the goal",
                description: error instanceof Error ? error.message : undefined,
              }),
            )
            .finally(() => setEnding(false));
        }}
      >
        End goal
      </Button>
    </div>
  );
}
