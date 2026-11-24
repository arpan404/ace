import {
  spadeClock,
  type SpadeAvatar,
  type SpadeGroupMember,
  type SpadeReach,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { SettingDisclosure, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { GroupFaces } from "./spade-group-faces.tsx";
import { reachKey, readReach, setReach, type SpadeReachChange } from "./spade-reach-api.ts";
import { readGroups } from "./spade-teams-api.ts";
import { useSpadeRoster } from "./use-spade-roster.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, fault, Refusal } from "./spade-settings-rows.tsx";

/*
 * Settings › Spade › General: Notifications, Morning brief, and Unusual spending alerts
 * (ADR 0195, ADR 0165, ADR 0166). Every row keeps the card's one clean left edge; dependent
 * schedule and threshold controls sit on their own SettingRows right beneath their toggle.
 */

const quarterHours: SelectOption<string>[] = Array.from({ length: 96 }, (_, index) => ({
  value: String(index * 15),
  label: spadeClock(index * 15),
}));
const perHour: SelectOption<string>[] = ["off", "2", "4", "6", "10", "20"].map((value) => ({
  value,
  label: value === "off" ? "No hourly limit" : `${value} / hr`,
}));
const perDay: SelectOption<string>[] = ["off", "10", "20", "30", "50", "100"].map((value) => ({
  value,
  label: value === "off" ? "No daily limit" : `${value} / day`,
}));
const factors: SelectOption<string>[] = [3, 5, 10, 20].map((n) => ({
  value: String(n),
  label: `${n}× its usual`,
}));
const floors: SelectOption<string>[] = [500_000, 1_000_000, 5_000_000, 20_000_000].map((m) => ({
  value: String(m),
  label: `Over $${(m / 1_000_000).toFixed(2)} an hour`,
}));

const approvalChoices: SelectOption<string>[] = [
  { value: "notify", label: "Notify me" },
  { value: "wait", label: "Wait for the morning brief" },
];

/** A bot or club the brief can cover, with its face for the list. */
export type BriefChoice =
  | { id: string; name: string; kind: "bot"; avatar: SpadeAvatar }
  | { id: string; name: string; kind: "club"; members: readonly SpadeGroupMember[] };

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
  const bots: BriefChoice[] = roster.bots
    .filter((bot) => bot.machine.primary && bot.parent === undefined)
    .map((bot) => ({ id: bot.id, name: bot.name, kind: "bot", avatar: bot.avatar }));
  const clubs: BriefChoice[] = (groups.data ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    kind: "club",
    members: group.members,
  }));
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
    <>
      <SettingSection
        label={label}
        anchor="notifications"
        note="Stops always reach you. Approvals and questions do too, unless you have them wait for the morning brief."
      >
        {refusal && <Refusal>{refusal}</Refusal>}
        <SwitchRow
          title="Notify me"
          checked={value.notify}
          onChange={(notify) => save({ notify })}
        />
        {value.notify && <QuietRows value={value} save={save} />}
      </SettingSection>
      <SettingSection label="Morning brief" anchor="morning-brief">
        <BriefRows value={value} save={save} choices={choices} />
      </SettingSection>
    </>
  );
}

/** Unusual spending alert rows, placed inside the Spending card where spending lives. */
export function SpendAlertRow(props: { ready: boolean }) {
  const { reach, change } = useReach(props.ready);
  const [refusal, setRefusal] = useState<string>();
  if (!reach.data) return null;
  const spend = reach.data.spend;
  const save = (next: SpadeReachChange) => {
    setRefusal(undefined);
    void change(next).catch((error: unknown) => setRefusal(fault(error)));
  };
  return (
    <>
      <SwitchRow
        title="Unusual spending"
        description={
          refusal ? <Refusal>{refusal}</Refusal> : "Alert when a bot spends sharply more than usual"
        }
        checked={spend.on}
        onChange={(on) => save({ spend: { on } })}
      />
      {spend.on && (
        <SettingRow title="Alert threshold" density="compact" inline>
          <span className="flex flex-wrap items-center justify-end gap-2">
            <Select
              label="Alert when a bot spends"
              className="w-36"
              value={String(spend.factor)}
              options={withValue(factors, spend.factor, (n) => `${n}× its usual`)}
              onValueChange={(next) => save({ spend: { factor: Number(next) } })}
            />
            <Select
              label="And more than"
              className="w-44 tabular-nums"
              value={String(spend.floorMicros)}
              options={withValue(
                floors,
                spend.floorMicros,
                (m) => `Over $${(m / 1_000_000).toFixed(2)} an hour`,
              )}
              onValueChange={(next) => save({ spend: { floor_micros: Number(next) } })}
            />
          </span>
        </SettingRow>
      )}
    </>
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
        description={
          value.dnd && holding ? (
            <span className="text-status-needs-you">{holding}</span>
          ) : undefined
        }
        checked={value.dnd}
        onChange={(dnd) => save({ dnd })}
      />
      <SwitchRow
        title="Quiet hours"
        description={
          quiet
            ? [
                `${spadeClock(quiet.from - (quiet.from % 15))} – ${spadeClock(quiet.to - (quiet.to % 15))}`,
                !value.dnd && value.waitingFor === "quiet" ? holding : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
        checked={quiet !== null}
        onChange={(on) => save({ quiet: on ? { from: 22 * 60, to: 7 * 60 } : null })}
      />
      {quiet && (
        <>
          <SettingRow title="Quiet hours schedule" density="compact" inline>
            <span className="flex flex-wrap items-center justify-end gap-2">
              <Select
                label="Quiet hours start"
                className="w-24 tabular-nums"
                value={String(quiet.from - (quiet.from % 15))}
                options={quarterHours}
                onValueChange={(next) => {
                  if (Number(next) !== quiet.to) save({ quiet: { ...quiet, from: Number(next) } });
                }}
              />
              <span className="text-xs text-subtle-foreground">–</span>
              <Select
                label="Quiet hours end"
                className="w-24 tabular-nums"
                value={String(quiet.to - (quiet.to % 15))}
                options={quarterHours}
                onValueChange={(next) => {
                  if (Number(next) !== quiet.from) save({ quiet: { ...quiet, to: Number(next) } });
                }}
              />
            </span>
          </SettingRow>
          <SettingRow title="Approvals and questions" density="compact" inline>
            <Select
              label="During quiet hours, approvals and questions"
              className="w-52 max-w-full"
              value={value.approvals}
              options={approvalChoices}
              onValueChange={(next) => save({ approvals: next === "wait" ? "wait" : "notify" })}
            />
          </SettingRow>
        </>
      )}
      <SettingRow
        title="Interruptions"
        description="Limit how often bots can interrupt you"
        density="compact"
        inline
      >
        <span className="flex flex-wrap items-center justify-end gap-2">
          <Select
            label="Interruptions an hour"
            className="w-32 tabular-nums"
            value={value.perHour === null ? "off" : String(value.perHour)}
            options={withValue(perHour, value.perHour, (n) => `${n} / hr`)}
            onValueChange={(next) =>
              save({ budget: { per_hour: next === "off" ? null : Number(next) } })
            }
          />
          <Select
            label="Interruptions a day"
            className="w-32 tabular-nums"
            value={value.perDay === null ? "off" : String(value.perDay)}
            options={withValue(perDay, value.perDay, (n) => `${n} / day`)}
            onValueChange={(next) =>
              save({ budget: { per_day: next === "off" ? null : Number(next) } })
            }
          />
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
        title="Daily summary"
        ariaLabel="Morning brief"
        description={
          brief.on
            ? `Delivered every day at ${spadeClock(brief.at - (brief.at % 15))}`
            : "A once-a-day recap of what waited while you were away"
        }
        checked={brief.on}
        onChange={(on) => save({ brief: { on } })}
      />
      {brief.on && (
        <SettingRow title="Delivery time" density="compact" inline>
          <Select
            label="Morning brief time"
            className="w-24 tabular-nums"
            value={String(brief.at - (brief.at % 15))}
            options={quarterHours}
            onValueChange={(next) => save({ brief: { at: Number(next) } })}
          />
        </SettingRow>
      )}
      {brief.on && choices.length > 0 && (
        <SettingDisclosure
          title={`Covers ${brief.bots === null ? "every bot" : `${choices.filter((c) => covered(c.id)).length} of ${choices.length}`}`}
        >
          <div className="grid grid-cols-1 gap-2 pt-1 pb-3 sm:grid-cols-2">
            {choices.map((choice) => (
              <BriefBotTile
                key={choice.id}
                choice={choice}
                checked={covered(choice.id)}
                onChange={(on) => cover(choice.id, on)}
              />
            ))}
          </div>
        </SettingDisclosure>
      )}
      {brief.on && (
        <SwitchRow
          title="Rewrite with the fast model"
          description="Turn raw updates into a short, readable recap"
          checked={brief.polish}
          onChange={(polish) => save({ brief: { polish } })}
        />
      )}
    </>
  );
}

/** One bot or club tile inside the Morning brief's Covers grid: its face, name, and switch. */
function BriefBotTile(props: {
  choice: BriefChoice;
  checked: boolean;
  onChange(on: boolean): void;
}) {
  const id = useId();
  const { choice } = props;
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-md border border-border-soft bg-surface-2/40 px-2.5 py-2">
      {choice.kind === "bot" ? (
        <SpadeFace avatar={choice.avatar} size={24} />
      ) : (
        <GroupFaces
          members={choice.members.map((member) => ({
            agent: member.agent,
            machineKey: member.machine ?? undefined,
            avatar: member.avatar,
            away: member.away,
          }))}
          size={24}
          className="[--faces-cut:var(--surface-2)]"
        />
      )}
      <label
        htmlFor={id}
        className="flex min-w-0 flex-1 flex-col text-ui font-medium text-foreground"
      >
        <span className="truncate">{choice.name}</span>
        {choice.kind === "club" && (
          <span className="text-xs font-normal text-subtle-foreground">Club</span>
        )}
      </label>
      <Switch id={id} checked={props.checked} onCheckedChange={props.onChange} />
    </div>
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
  ariaLabel?: string | undefined;
  description?: ReactNode;
  checked: boolean;
  onChange(on: boolean): void;
}) {
  const id = useId();
  return (
    <SettingRow
      title={props.title}
      description={props.description}
      htmlFor={props.ariaLabel ? undefined : id}
      density="compact"
      inline
    >
      <Switch
        id={id}
        aria-label={props.ariaLabel}
        checked={props.checked}
        onCheckedChange={props.onChange}
      />
    </SettingRow>
  );
}
