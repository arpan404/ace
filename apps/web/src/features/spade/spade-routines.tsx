import {
  spadeRunWords,
  spadeWhenInSentence,
  type SpadeHeartbeat,
  type SpadeRoutine,
} from "@ace/ui-core/spade-chat";
import { useState, type ReactNode } from "react";
import { SettingAddRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { part } from "@/lib/suit-part.ts";
import { fault } from "./spade-profile-actions.ts";
import { ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { HeartbeatEditor, RoutineEditor } from "./spade-routine-editors.tsx";
import { editRoutine, runRoutine, saveHeartbeat } from "./spade-routines-api.ts";
import { useSpadeRoutines } from "./use-spade-routines.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Which row is open for editing: a routine, the heartbeat, or a new routine at the foot. */
type Editing = { kind: "routine"; id: string } | { kind: "heartbeat" } | { kind: "new" };

/**
 * Routines (ADR 0129), a section of Details: one row each with its name, when it runs in words
 * (or that its last run failed, or that it is paused) and a switch that pauses it; Run now on
 * hover. A row opens to its editor where it is. The heartbeat is a row like the others; Add
 * routine opens a new one at the foot.
 */
export function ProfileRoutines(props: { bot: RosterBot }) {
  const { bot } = props;
  const { routines, heartbeat, client, refresh } = useSpadeRoutines(bot.id);
  const [editing, setEditing] = useState<Editing>();
  const toast = useToast();
  const now = useNow();
  const act = (what: string, work: Promise<unknown>) =>
    void work.then(
      () => refresh(),
      (error: unknown) => toast.error({ title: `Couldn't ${what}`, description: fault(error) }),
    );
  const done = () => setEditing(undefined);
  const saved = () => void refresh();
  return (
    <ProfileSection label="Routines">
      {routines.isPending ? (
        <ListSkeleton label="routines" shape="row" rows={2} />
      ) : routines.isError ? (
        <ProfileProblem
          text="Couldn't read the routines."
          onRetry={() => void routines.refetch()}
        />
      ) : (
        routines.data.map((routine) =>
          editing?.kind === "routine" && editing.id === routine.id ? (
            <RoutineEditor
              key={routine.id}
              agent={bot.id}
              routine={routine}
              onDone={done}
              onSaved={saved}
            />
          ) : (
            <RoutineRow
              key={routine.id}
              name={routine.name}
              line={<RoutineLine routine={routine} now={now} />}
              on={!routine.paused}
              onOpen={() => setEditing({ kind: "routine", id: routine.id })}
              onSwitch={(on) =>
                act(
                  on ? `resume ${routine.name}` : `pause ${routine.name}`,
                  editRoutine(client, routine.id, { paused: !on }),
                )
              }
              run={
                !routine.paused && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Run ${routine.name} now`}
                    className={rowPill}
                    onClick={() => act(`run ${routine.name}`, runRoutine(client, routine.id))}
                  >
                    Run now
                  </Button>
                )
              }
            />
          ),
        )
      )}
      {heartbeat.data &&
        (editing?.kind === "heartbeat" ? (
          <HeartbeatEditor
            agent={bot.id}
            heartbeat={heartbeat.data}
            onDone={done}
            onSaved={saved}
          />
        ) : (
          <HeartbeatRow
            heartbeat={heartbeat.data}
            now={now}
            onOpen={() => setEditing({ kind: "heartbeat" })}
            onSwitch={(on) =>
              act(
                on ? "turn the heartbeat on" : "turn the heartbeat off",
                saveHeartbeat(client, bot.id, { enabled: on }),
              )
            }
          />
        ))}
      {editing?.kind === "new" ? (
        <RoutineEditor agent={bot.id} routine={undefined} onDone={done} onSaved={saved} />
      ) : (
        <SettingAddRow onClick={() => setEditing({ kind: "new" })}>Add routine</SettingAddRow>
      )}
    </ProfileSection>
  );
}

/** A routine's row: the name and its line open its editor; Run now on hover; its switch. */
function RoutineRow(props: {
  name: string;
  line: ReactNode;
  on: boolean;
  onOpen(): void;
  onSwitch(on: boolean): void;
  run?: ReactNode;
}) {
  return (
    <div
      data-setting-slot=""
      {...part("list-row", props.on && "checked", "routine")}
      className="group/routine flex min-h-(--setting-row-height) items-center gap-3 py-2"
    >
      <button
        type="button"
        aria-label={`Edit ${props.name}`}
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left focus-ring"
      >
        <span className="truncate text-ui font-medium text-foreground">{props.name}</span>
        <span className="text-xs text-subtle-foreground">{props.line}</span>
      </button>
      {props.run && (
        <span className="hidden group-focus-within/routine:flex group-hover/routine:flex pointer-coarse:flex">
          {props.run}
        </span>
      )}
      <Switch aria-label={props.name} checked={props.on} onCheckedChange={props.onSwitch} />
    </div>
  );
}

/**
 * When it runs, in words: `Weekdays at 9:00 · next Mon 9:00`; paused reads Paused; a last run
 * that failed says so in its row, in the failed colour.
 */
export function RoutineLine(props: { routine: SpadeRoutine; now: number }) {
  const { routine, now } = props;
  const last = routine.lastRun;
  if (routine.paused) return "Paused";
  if (last?.result === "failed")
    return (
      <span className="text-destructive">{`Last run ${spadeRunWords(last).toLowerCase()}`}</span>
    );
  const next =
    routine.nextRun === undefined
      ? undefined
      : `next ${spadeWhenInSentence(routine.nextRun, now, routine.timeZone)}`;
  return [routine.words, next].filter(Boolean).join(" · ");
}

function every(minutes: number) {
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** The heartbeat's row: its words, Off while it is off; with no checklist yet, on opens it. */
function HeartbeatRow(props: {
  heartbeat: SpadeHeartbeat;
  now: number;
  onOpen(): void;
  onSwitch(on: boolean): void;
}) {
  const beat = props.heartbeat;
  const line = !beat.enabled
    ? "Off"
    : [
        every(beat.everyMinutes),
        beat.quiet && `quiet ${beat.quiet.start} to ${beat.quiet.end}`,
        beat.nextRun !== undefined &&
          `next ${spadeWhenInSentence(beat.nextRun, props.now, beat.timeZone)}`,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <RoutineRow
      name="Heartbeat"
      line={line}
      on={beat.enabled}
      onOpen={props.onOpen}
      // Nothing to check yet: the checklist comes first.
      onSwitch={(on) => (on && !beat.checklist.trim() ? props.onOpen() : props.onSwitch(on))}
    />
  );
}
