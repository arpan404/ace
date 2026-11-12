import {
  spadeRunWords,
  spadeWhenInSentence,
  type SpadeHeartbeat,
  type SpadeRoutine,
} from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { SettingAddRow, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { readingColumn } from "@/features/thread/index.ts";
import { useNow } from "@/lib/time.ts";
import { HeartbeatDialog, RoutineDialog } from "./spade-routine-dialogs.tsx";
import { editRoutine, runRoutine, saveHeartbeat } from "./spade-routines-api.ts";
import { useSpadeRoutines } from "./use-spade-routines.ts";
import type { RosterBot } from "./use-spade-roster.ts";

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * A bot's routines (ADR 0129): each with its trigger in words, its next run and how the last one
 * went, with Run now, Pause and Edit; Add routine; and the bot's heartbeat.
 */
export function SpadeRoutines(props: { bot: RosterBot }) {
  const { bot } = props;
  const { routines, heartbeat, client, refresh } = useSpadeRoutines(bot.id);
  const [editing, setEditing] = useState<SpadeRoutine | "new">();
  const [beating, setBeating] = useState(false);
  const toast = useToast();
  const now = useNow();
  const act = (what: string, work: Promise<unknown>) =>
    void work.then(
      () => refresh(),
      (error: unknown) => toast.error({ title: `Couldn't ${what}`, description: fault(error) }),
    );
  return (
    <div className="h-full overflow-y-auto">
      <div className={`${readingColumn} flex flex-col gap-8 py-6`}>
        <SettingSection label="Routines">
          {routines.isPending ? (
            <ListSkeleton label="routines" shape="row" rows={2} />
          ) : routines.isError ? (
            <SettingRow title="Couldn't read the routines" description={routines.error.message}>
              <Button size="sm" onClick={() => void routines.refetch()}>
                Try again
              </Button>
            </SettingRow>
          ) : (
            routines.data.map((routine) => (
              <SettingRow
                key={routine.id}
                title={routine.name}
                description={<RoutineFacts routine={routine} now={now} />}
              >
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Run ${routine.name} now`}
                    onClick={() => act("run it", runRoutine(client, routine.id))}
                  >
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${routine.paused ? "Resume" : "Pause"} ${routine.name}`}
                    onClick={() =>
                      act(
                        routine.paused ? "resume it" : "pause it",
                        editRoutine(client, routine.id, { paused: !routine.paused }),
                      )
                    }
                  >
                    {routine.paused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${routine.name}`}
                    onClick={() => setEditing(routine)}
                  >
                    Edit
                  </Button>
                </div>
              </SettingRow>
            ))
          )}
          <SettingAddRow onClick={() => setEditing("new")}>Add routine</SettingAddRow>
        </SettingSection>
        <SettingSection label="Heartbeat">
          {heartbeat.isPending ? (
            <ListSkeleton label="heartbeat" shape="row" rows={1} />
          ) : heartbeat.isError ? (
            <SettingRow title="Couldn't read the heartbeat" description={heartbeat.error.message}>
              <Button size="sm" onClick={() => void heartbeat.refetch()}>
                Try again
              </Button>
            </SettingRow>
          ) : (
            <SettingRow
              title={heartbeat.data.checklist.split("\n")[0]?.trim() || "No checklist yet"}
              description={heartbeatFacts(heartbeat.data, now)}
              inline
            >
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Edit heartbeat"
                  onClick={() => setBeating(true)}
                >
                  Edit
                </Button>
                <Switch
                  aria-label="Heartbeat"
                  checked={heartbeat.data.enabled}
                  onCheckedChange={(checked) => {
                    // Nothing to check yet: the checklist comes first.
                    if (checked && !heartbeat.data.checklist.trim()) setBeating(true);
                    else
                      act(
                        checked ? "turn the heartbeat on" : "turn the heartbeat off",
                        saveHeartbeat(client, bot.id, { enabled: checked }),
                      );
                  }}
                />
              </div>
            </SettingRow>
          )}
        </SettingSection>
      </div>
      {editing && (
        <RoutineDialog
          agent={bot.id}
          routine={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => void refresh()}
        />
      )}
      {beating && heartbeat.data && (
        <HeartbeatDialog
          agent={bot.id}
          heartbeat={heartbeat.data}
          onClose={() => setBeating(false)}
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}

/** `Weekdays at 9:00 · Next: Fri 9:00`, then how the last run went. */
function RoutineFacts(props: { routine: SpadeRoutine; now: number }) {
  const { routine, now } = props;
  const next = routine.paused
    ? "Paused"
    : routine.nextRun === undefined
      ? undefined
      : `Next: ${spadeWhenInSentence(routine.nextRun, now, routine.timeZone)}`;
  const last = routine.lastRun;
  return (
    <>
      <span className="block">{[routine.words, next].filter(Boolean).join(" · ")}</span>
      {last && (
        <span className="block">
          {`Last: ${spadeWhenInSentence(last.at, now, routine.timeZone)} · ${spadeRunWords(last)}`}
        </span>
      )}
    </>
  );
}

function every(minutes: number) {
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

function heartbeatFacts(beat: SpadeHeartbeat, now: number): string {
  if (!beat.enabled) return "Off";
  return [
    every(beat.everyMinutes),
    beat.quiet && `Quiet ${beat.quiet.start} to ${beat.quiet.end}`,
    beat.nextRun !== undefined && `Next: ${spadeWhenInSentence(beat.nextRun, now, beat.timeZone)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
