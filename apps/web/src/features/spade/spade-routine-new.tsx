import { CaretRightIcon, CheckIcon } from "@ace/icons";
import type { SpadeAceEvent, SpadeTrigger } from "@ace/ui-core/spade-chat";
import { spadeWhenInSentence } from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingCard } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import { ProfilePage } from "./spade-profile-page.tsx";
import { profileRowClass, profileWell } from "./spade-profile-parts.tsx";
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
  const selectedOther = others.find((each) => each.value === when);
  return (
    <ProfilePage title="New routine" onBack={props.onBack}>
      <form
        aria-label="New routine"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        className="flex flex-col gap-5"
      >
        <section className="flex flex-col">
          <div className="mx-1 mb-1.5 flex min-h-5 items-center">
            <label htmlFor={ids.what} className="text-xs font-medium text-muted-foreground">
              What to do
            </label>
          </div>
          <SettingCard>
            <div data-setting-slot="" className="py-3">
              <textarea
                id={ids.what}
                value={instruction}
                autoFocus
                rows={3}
                maxLength={4000}
                disabled={saving}
                placeholder={placeholderOf(bot.task)}
                onChange={(event) => setInstruction(event.target.value)}
                className={cn(profileWell, "min-h-24 py-2.5")}
              />
            </div>
          </SettingCard>
        </section>

        <section className="flex flex-col">
          <div className="mx-1 mb-1.5 flex min-h-5 items-center">
            <label htmlFor={ids.when} className="text-xs font-medium text-muted-foreground">
              When
            </label>
          </div>
          <SettingCard>
            {when === "schedule" ? (
              <div data-setting-slot="" className="flex flex-col gap-2.5 py-3">
                <Input
                  id={ids.when}
                  value={schedule}
                  disabled={saving}
                  placeholder="weekdays at 9:00"
                  onChange={(event) => setSchedule(event.target.value)}
                />
                <div className="flex flex-wrap gap-1.5">
                  {routineChips.map((chip) => {
                    const active = schedule === chip.schedule;
                    return (
                      <button
                        key={chip.label}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSchedule(chip.schedule)}
                        className={cn(
                          "h-7 rounded-full px-2.5 text-xs font-medium transition-colors duration-(--motion-fast) focus-ring",
                          active
                            ? "bg-active text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]"
                            : "bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-soft)] hover:bg-hover hover:text-foreground",
                        )}
                      >
                        {chip.label}
                      </button>
                    );
                  })}
                </div>
                {next !== undefined && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {`Next: ${spadeWhenInSentence(next, now, personZone())}`}
                  </p>
                )}
              </div>
            ) : (
              <div
                data-setting-slot=""
                className="flex min-h-11 items-center justify-between gap-2 py-2"
              >
                <span className="truncate text-ui text-foreground">{selectedOther?.label}</span>
                <button
                  type="button"
                  onClick={() => setWhen("schedule")}
                  className="-mr-2 h-7 shrink-0 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground"
                >
                  Use schedule
                </button>
              </div>
            )}
            <button
              type="button"
              data-setting-slot=""
              aria-expanded={more}
              onClick={() => setMore((open) => !open)}
              className={cn(
                profileRowClass,
                "-mx-4 min-h-11 w-[calc(100%+2rem)] py-2.5 text-ui text-muted-foreground hover:text-foreground",
                !more && "rounded-b-lg",
              )}
            >
              <span className="flex-1">Or when…</span>
              <Icon
                icon={CaretRightIcon}
                size={13}
                className={cn(
                  "shrink-0 text-subtle-foreground transition-transform duration-(--motion-fast)",
                  more && "rotate-90",
                )}
              />
            </button>
            {more && (
              <div
                role="radiogroup"
                aria-label="Or when"
                data-setting-slot=""
                className="-mx-4 flex flex-col divide-y divide-border-soft"
              >
                {[{ value: "schedule" as const, label: "On a schedule" }, ...others].map(
                  (option) => {
                    const checked = when === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        onClick={() => setWhen(option.value)}
                        className={cn(
                          profileRowClass,
                          "min-h-11 py-2.5 text-ui last:rounded-b-lg",
                          checked ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <span className="flex-1">{option.label}</span>
                        {checked && (
                          <Icon icon={CheckIcon} size={14} className="shrink-0 text-foreground" />
                        )}
                      </button>
                    );
                  },
                )}
              </div>
            )}
          </SettingCard>
          <p className="mx-1 mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {when === "schedule"
              ? "Type any phrase like “every weekday at 9:00” or pick a preset above."
              : "Runs automatically whenever this trigger fires."}
          </p>
        </section>

        {problem && (
          <p role="alert" className="mx-1 text-xs text-destructive">
            {problem}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          disabled={!ready || saving}
          className="h-9 w-full rounded-md"
        >
          {saving ? "Creating…" : "Create"}
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
