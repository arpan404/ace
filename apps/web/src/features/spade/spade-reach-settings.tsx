import { spadeClock, type SpadeReach } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { reachKey, readReach, setReach, type SpadeReachChange } from "./spade-reach-api.ts";
import { readGroups } from "./spade-teams-api.ts";
import { useSpadeRoster } from "./use-spade-roster.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, fault, Refusal } from "./spade-settings-rows.tsx";

/*
 * Settings › Spade › General, Notifications (ADR 0195): whether Spade notifies at all, do not
 * disturb now, a daily quiet window, the interruption budget, the morning brief (ADR 0165's
 * amendment) and spend alerts (ADR 0166's amendment). Each change applies at once.
 */

const quarterHours: SelectOption<string>[] = Array.from({ length: 96 }, (_, index) => ({
  value: String(index * 15),
  label: spadeClock(index * 15),
}));
const perHour = ["off", "2", "4", "6", "10", "20"].map(bound);
const perDay = ["off", "10", "20", "30", "50", "100"].map(bound);
const factors: SelectOption<string>[] = [3, 5, 10, 20].map((n) => ({
  value: String(n),
  label: `${n}× its usual`,
}));
const floors: SelectOption<string>[] = [500_000, 1_000_000, 5_000_000, 20_000_000].map((m) => ({
  value: String(m),
  label: `Over $${(m / 1_000_000).toFixed(2)} an hour`,
}));

function bound(value: string): SelectOption<string> {
  return { value, label: value === "off" ? "No limit" : value };
}

/** A bot or club the brief can cover. */
export interface BriefChoice {
  id: string;
  name: string;
}

export function useReach(ready: boolean) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const reach = useQuery({
    queryKey: [...reachKey, machine],
    queryFn: ({ signal }) => readReach(client, signal),
    enabled: ready,
    // What waits and why changes on its own (quiet hours start and end).
    refetchInterval: 60_000,
  });
  const change = async (next: SpadeReachChange) => {
    const saved = await setReach(client, next);
    cache.setQueryData([...reachKey, machine], saved);
  };
  return { reach, change };
}

/** What a brief can cover on this machine: its bots the person made, and its clubs. */
function useBriefChoices(ready: boolean): BriefChoice[] {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const roster = useSpadeRoster(ready);
  const groups = useQuery({
    queryKey: ["spade", "reach-groups", machine],
    queryFn: ({ signal }) => readGroups(client, { signal }),
    enabled: ready,
  });
  const bots = roster.bots
    .filter((bot) => bot.machine.primary && bot.parent === undefined)
    .map((bot) => ({ id: bot.id, name: bot.name }));
  const clubs = (groups.data ?? []).map((group) => ({ id: group.id, name: group.name }));
  return [...bots, ...clubs];
}

export function ReachSection(props: { ready: boolean }) {
  const { reach, change } = useReach(props.ready);
  const choices = useBriefChoices(props.ready);
  const [refusal, setRefusal] = useState<string>();
  const label = "Notifications";
  if (reach.isPending)
    return (
      <SettingSection label={label} anchor="notifications">
        <LoadingRows label="Spade's notification settings" rows={3} />
      </SettingSection>
    );
  if (reach.isError)
    return (
      <SettingSection label={label} anchor="notifications">
        <CouldNotRead
          what="Spade's notification settings"
          error={reach.error}
          retry={() => void reach.refetch()}
        />
      </SettingSection>
    );
  const value = reach.data;
  const save = (next: SpadeReachChange) => {
    setRefusal(undefined);
    void change(next).catch((error: unknown) => setRefusal(fault(error)));
  };
  return (
    <SettingSection
      label={label}
      anchor="notifications"
      note="Approvals, questions a bot waits on and stops always reach you."
    >
      {refusal && <Refusal>{refusal}</Refusal>}
      <SwitchRow title="Notify me" checked={value.notify} onChange={(notify) => save({ notify })} />
      {value.notify && <QuietRows value={value} save={save} />}
      <BriefRows value={value} save={save} choices={choices} />
      <SpendRows value={value} save={save} />
    </SettingSection>
  );
}

type Rows = { value: SpadeReach; save(next: SpadeReachChange): void };

function QuietRows({ value, save }: Rows) {
  const holding = value.held > 0 ? `${value.held} waiting for you` : undefined;
  const quiet = value.quiet;
  return (
    <>
      <SwitchRow
        title="Do not disturb"
        description={value.dnd ? holding : undefined}
        checked={value.dnd}
        onChange={(dnd) => save({ dnd })}
      />
      <SwitchRow
        title="Quiet hours"
        description={!value.dnd && value.waitingFor === "quiet" ? holding : undefined}
        checked={quiet !== null}
        onChange={(on) => save({ quiet: on ? { from: 22 * 60, to: 7 * 60 } : null })}
      >
        {quiet && (
          <>
            <Select
              label="Quiet hours start"
              className="min-w-0 tabular-nums"
              value={String(quiet.from - (quiet.from % 15))}
              options={quarterHours}
              onValueChange={(next) => {
                if (Number(next) !== quiet.to) save({ quiet: { ...quiet, from: Number(next) } });
              }}
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Select
              label="Quiet hours end"
              className="min-w-0 tabular-nums"
              value={String(quiet.to - (quiet.to % 15))}
              options={quarterHours}
              onValueChange={(next) => {
                if (Number(next) !== quiet.from) save({ quiet: { ...quiet, to: Number(next) } });
              }}
            />
          </>
        )}
      </SwitchRow>
      <SettingRow title="Interruptions" density="compact" inline>
        <span className="flex items-center justify-end gap-2">
          <Select
            label="Interruptions an hour"
            className="min-w-0 tabular-nums"
            value={value.perHour === null ? "off" : String(value.perHour)}
            options={withValue(perHour, value.perHour, (n) => `${n}`)}
            onValueChange={(next) =>
              save({ budget: { per_hour: next === "off" ? null : Number(next) } })
            }
          />
          <span className="text-sm text-muted-foreground">an hour,</span>
          <Select
            label="Interruptions a day"
            className="min-w-0 tabular-nums"
            value={value.perDay === null ? "off" : String(value.perDay)}
            options={withValue(perDay, value.perDay, (n) => `${n}`)}
            onValueChange={(next) =>
              save({ budget: { per_day: next === "off" ? null : Number(next) } })
            }
          />
          <span className="text-sm text-muted-foreground">a day</span>
        </span>
      </SettingRow>
    </>
  );
}

function BriefRows({ value, save, choices }: Rows & { choices: readonly BriefChoice[] }) {
  const brief = value.brief;
  const covered = (id: string) => brief.bots === null || brief.bots.includes(id);
  const cover = (id: string, on: boolean) => {
    const now = brief.bots ?? choices.map((choice) => choice.id);
    const next = on ? [...new Set([...now, id])] : now.filter((each) => each !== id);
    save({ brief: { bots: next.length === choices.length ? null : next } });
  };
  return (
    <>
      <SwitchRow
        title="Morning brief"
        checked={brief.on}
        onChange={(on) => save({ brief: { on } })}
      >
        {brief.on && (
          <Select
            label="Morning brief time"
            className="min-w-0 tabular-nums"
            value={String(brief.at - (brief.at % 15))}
            options={quarterHours}
            onValueChange={(next) => save({ brief: { at: Number(next) } })}
          />
        )}
      </SwitchRow>
      {brief.on &&
        choices.map((choice) => (
          <SwitchRow
            key={choice.id}
            title={choice.name}
            indent
            checked={covered(choice.id)}
            onChange={(on) => cover(choice.id, on)}
          />
        ))}
      {brief.on && (
        <SwitchRow
          title="Rewrite with the fast model"
          indent
          checked={brief.polish}
          onChange={(polish) => save({ brief: { polish } })}
        />
      )}
    </>
  );
}

function SpendRows({ value, save }: Rows) {
  const spend = value.spend;
  return (
    <SwitchRow
      title="Unusual spending"
      checked={spend.on}
      onChange={(on) => save({ spend: { on } })}
    >
      {spend.on && (
        <>
          <Select
            label="Alert when a bot spends"
            className="min-w-0"
            value={String(spend.factor)}
            options={withValue(factors, spend.factor, (n) => `${n}× its usual`)}
            onValueChange={(next) => save({ spend: { factor: Number(next) } })}
          />
          <Select
            label="And more than"
            className="min-w-0 tabular-nums"
            value={String(spend.floorMicros)}
            options={withValue(
              floors,
              spend.floorMicros,
              (m) => `Over $${(m / 1_000_000).toFixed(2)} an hour`,
            )}
            onValueChange={(next) => save({ spend: { floor_micros: Number(next) } })}
          />
        </>
      )}
    </SwitchRow>
  );
}

/** The options, with a stored value not among them (set elsewhere) shown too. */
function withValue(
  options: readonly SelectOption<string>[],
  value: number | null,
  label: (value: number) => string,
): SelectOption<string>[] {
  if (value === null || options.some((option) => option.value === String(value)))
    return [...options];
  return [...options, { value: String(value), label: label(value) }];
}

function SwitchRow(props: {
  title: string;
  description?: string | undefined;
  checked: boolean;
  indent?: boolean;
  onChange(on: boolean): void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <SettingRow
      title={props.indent ? <span className="pl-4">{props.title}</span> : props.title}
      description={props.description}
      htmlFor={id}
      density="compact"
      inline
    >
      <span className="flex items-center justify-end gap-2">
        {props.children}
        <Switch id={id} checked={props.checked} onCheckedChange={props.onChange} />
      </span>
    </SettingRow>
  );
}
