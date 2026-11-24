import type { SpadeAceEvent, SpadeTrigger } from "@ace/ui-core/spade-chat";
import { spadeWhenInSentence } from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { SettingCard } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import { ProfilePage } from "./spade-profile-page.tsx";
import { fault } from "./spade-profile-actions.ts";
import { nextRunOf, routineChips, routineNameOf } from "./spade-routine-preview.ts";
import { addRoutine, personZone } from "./spade-routines-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { useSpadeRoutines } from "./use-spade-routines.ts";
import type { RosterBot } from "./use-spade-roster.ts";

type When = "schedule" | SpadeAceEvent | "webhook";

const others: { value: Exclude<When, "schedule">; label: string }[] = [
  { value: "thread_done", label: "An ace thread finishes" },
  { value: "thread_failed", label: "An ace thread fails" },
  { value: "thread_needs_you", label: "An ace thread needs you" },
  { value: "webhook", label: "A webhook is called" },
];

const well =
  "min-h-24 w-full resize-none rounded-md bg-chat-well px-3 py-2.5 text-ui leading-5 text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none [field-sizing:content] placeholder:text-subtle-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground)]";

const triggerOf = (when: When, schedule: string): SpadeTrigger =>
  when === "schedule"
    ? { kind: "schedule", schedule: schedule.trim() }
    : when === "webhook"
      ? { kind: "webhook" }
      : { kind: "event", event: when };

/**
 * New routine, one short page in the profile panel: what to do, when (a schedule in Spade's
 * phrases with quick chips and a line for the next run, or "Or when…" a thread event or a
 * webhook), and Create, which saves through the routines API and goes back with the routine in
 * the list. Spade's own words say why when it can't read a schedule.
 */
export function NewRoutinePage(props: { bot: RosterBot; onBack(): void; onCreated(): void }) {
  const { bot } = props;
  const ids = { what: useId(), when: useId() };
  const client = useSpadeClient();
  const { refresh } = useSpadeRoutines(bot.id);
  const now = useNow();
  const [instruction, setInstruction] = useState("");
  const [schedule, setSchedule] = useState("");
  const [when, setWhen] = useState<When>("schedule");
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const next = when === "schedule" && schedule.trim() ? nextRunOf(schedule, now) : undefined;
  const ready = instruction.trim() !== "" && (when !== "schedule" || schedule.trim() !== "");
  const create = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setProblem(undefined);
    try {
      await addRoutine(client, bot.id, {
        name: routineNameOf(instruction),
        instruction: instruction.trim(),
        trigger: triggerOf(when, schedule),
      });
      await refresh();
      props.onCreated();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ProfilePage title="New routine" onBack={props.onBack}>
      <form
        aria-label="New routine"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        className="flex flex-col gap-6"
      >
        <section className="flex flex-col gap-1.5">
          <label htmlFor={ids.what} className="mx-1 text-ui text-muted-foreground">
            What to do
          </label>
          <textarea
            id={ids.what}
            value={instruction}
            autoFocus
            rows={3}
            placeholder={placeholderOf(bot.task)}
            onChange={(event) => setInstruction(event.target.value)}
            className={well}
          />
        </section>
        <section className="flex flex-col gap-1.5">
          <label htmlFor={ids.when} className="mx-1 text-ui text-muted-foreground">
            When
          </label>
          {when === "schedule" ? (
            <>
              <Input
                id={ids.when}
                value={schedule}
                placeholder="weekdays at 9:00"
                onChange={(event) => setSchedule(event.target.value)}
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {routineChips.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    aria-pressed={schedule === chip.schedule}
                    onClick={() => setSchedule(chip.schedule)}
                    className={cn(
                      "h-7 rounded-full px-3 text-ui focus-ring",
                      schedule === chip.schedule
                        ? "bg-active text-foreground"
                        : "bg-hover text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
              {next !== undefined && (
                <p className="mx-1 pt-1 text-ui text-muted-foreground">
                  {`Next: ${spadeWhenInSentence(next, now, personZone())}`}
                </p>
              )}
            </>
          ) : (
            <p className="mx-1 text-ui text-foreground">
              {others.find((each) => each.value === when)?.label}
            </p>
          )}
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((open) => !open)}
            className="mx-1 w-fit rounded-md py-1 text-ui text-muted-foreground focus-ring hover:text-foreground"
          >
            Or when…
          </button>
          {more && (
            <SettingCard>
              <div role="radiogroup" aria-label="Or when" className="flex flex-col">
                {[{ value: "schedule" as const, label: "On a schedule" }, ...others].map(
                  (option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={when === option.value}
                      data-setting-slot=""
                      onClick={() => setWhen(option.value)}
                      className="flex min-h-11 items-center gap-3 text-left text-ui text-foreground focus-ring"
                    >
                      <span className="flex-1">{option.label}</span>
                      {when === option.value && <span aria-hidden>✓</span>}
                    </button>
                  ),
                )}
              </div>
            </SettingCard>
          )}
        </section>
        {problem && (
          <p role="alert" className="mx-1 text-ui text-destructive">
            {problem}
          </p>
        )}
        <Button type="submit" disabled={!ready || saving} className="h-10 rounded-full">
          Create
        </Button>
      </form>
    </ProfilePage>
  );
}

/** The field's hint from the bot's task, so it reads as a thing this bot would do. */
function placeholderOf(task: string): string {
  const line = task.trim().split("\n")[0] ?? "";
  return line ? `${line.slice(0, 70)}` : "Check new issues and label them";
}
