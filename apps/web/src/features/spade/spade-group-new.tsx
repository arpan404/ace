import {
  spadeGroupMembersMax,
  spadeGroupMembersMin,
  spadeGroupNameMax,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useMachines } from "@/lib/machines.ts";
import {
  choicesOf,
  draftBody,
  draftLead,
  draftProblem,
  draftStart,
  type MemberChoice,
} from "./group-draft.ts";
import { SpadeFace } from "./spade-face.tsx";
import { spadeMachineKey } from "./spade-machine.tsx";
import { GroupFaces } from "./spade-group-faces.tsx";
import { ConversationSkeleton, message, useSpadeLine } from "./spade-screen-parts.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { createGroup } from "./spade-teams-api.ts";
import { groupsKey } from "./use-spade-groups.ts";
import { useSpadeRoster } from "./use-spade-roster.ts";

/**
 * `/spade/groups/new`: New group in place (docs/design/spade.md §5), where the group will live
 * once it's made: the members' faces, its name, then its members, Spade among them to start
 * with. Who answers what has no @ is a picked member (Spade while it is picked), and the group
 * lives on that member's machine, so there is no machine to choose. Making it opens its
 * conversation.
 */
export function SpadeNewGroupScreen() {
  const line = useSpadeLine();
  const roster = useSpadeRoster(line.ready);
  const machines = useMachines();
  const choices = choicesOf(roster.bots, machines);
  const primary = machines.find((machine) => machine.primary)?.id ?? "";
  return (
    <Screen title="New group" namedByPanel>
      <div className="h-full overflow-y-auto">
        <div className={cn(readingColumn, "max-w-120 pt-10 pb-16")}>
          {!line.ready ? (
            <SpadeStateStrip line={line} className="flex items-center gap-2 px-1 text-ui" />
          ) : roster.loading ? (
            <ConversationSkeleton />
          ) : (
            <Draft choices={choices} primaryHost={primary} />
          )}
        </div>
      </div>
    </Screen>
  );
}

function Draft(props: { choices: readonly MemberChoice[]; primaryHost: string }) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const machines = useMachines();
  const [name, setName] = useState("");
  const [keys, setKeys] = useState(() => draftStart(props.choices, props.primaryHost));
  const [asked, setAsked] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  // This machine's bots first, as the roster has them.
  const ordered = props.choices.toSorted(
    (a, b) => Number(b.host === props.primaryHost) - Number(a.host === props.primaryHost),
  );
  // In the order the person picked them: the group keeps that order.
  const picked = keys.flatMap((key) => ordered.filter((choice) => choice.key === key));
  const lead = draftLead(picked, asked);
  const blocked = draftProblem(name, picked);
  const where = (choice: MemberChoice) =>
    choice.host === props.primaryHost ? choice.name : `${choice.name} on ${choice.machineName}`;
  const make = async () => {
    if (blocked || !lead) return;
    const client = machines.find((machine) => machine.id === lead.host)?.client;
    if (!client) {
      setProblem(`${lead.machineName} isn't reachable right now.`);
      return;
    }
    setSaving(true);
    setProblem(undefined);
    try {
      const group = await createGroup(client, draftBody(name, picked, lead));
      await cache.invalidateQueries({ queryKey: groupsKey });
      const home = machines.find((machine) => machine.id === lead.host);
      void navigate({
        to: "/spade/groups/$groupId",
        params: { groupId: group.id },
        search: home && !home.primary ? { on: spadeMachineKey(home) } : {},
        replace: true,
      });
    } catch (error) {
      setProblem(message(error));
      setSaving(false);
    }
  };
  return (
    <form
      aria-label="New group"
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void make();
      }}
    >
      <div className="flex flex-col items-center gap-3">
        {picked.length > 0 ? (
          <GroupFaces members={picked} size={72} className="[--faces-cut:var(--background)]" />
        ) : (
          <span aria-hidden className="size-18 rounded-full bg-surface-1" />
        )}
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the draft opens to be named
          autoFocus
          aria-label="Name"
          placeholder="Name the group"
          value={name}
          maxLength={spadeGroupNameMax}
          onChange={(event) => setName(event.target.value.replaceAll(/[\r\n]/g, " "))}
          className="w-full max-w-80 rounded-md bg-(--chat-well) px-2.5 py-0.5 text-center text-[22px] leading-7 font-semibold text-foreground outline-none placeholder:text-subtle-foreground focus-ring"
        />
      </div>
      <h2 className="mt-6 mb-1.5 ml-3 text-ui font-medium text-muted-foreground">
        {`Members · ${spadeGroupMembersMin} to ${spadeGroupMembersMax}`}
      </h2>
      <ul aria-label="Members" className="flex flex-col gap-0.5">
        {ordered.map((choice) => {
          const on = keys.includes(choice.key);
          return (
            <li key={choice.key}>
              <label
                className={cn(
                  "flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-1.5 text-md text-foreground hover:bg-hover",
                  on && "bg-surface-1",
                )}
              >
                <SpadeFace
                  avatar={choice.avatar}
                  size={32}
                  className={choice.away ? "opacity-45" : undefined}
                />
                <span aria-hidden className="min-w-0 flex-1 truncate">
                  {choice.name}
                </span>
                {choice.host !== props.primaryHost && (
                  <span aria-hidden className="shrink-0 text-ui text-subtle-foreground">
                    {choice.machineName}
                  </span>
                )}
                <Checkbox
                  checked={on}
                  aria-label={where(choice)}
                  onCheckedChange={(next) =>
                    setKeys((now) =>
                      next === true
                        ? [...now, choice.key]
                        : now.filter((key) => key !== choice.key),
                    )
                  }
                />
              </label>
            </li>
          );
        })}
      </ul>
      {picked.length > 1 && lead && (
        <div className="mt-4 flex min-h-12 items-center gap-3 rounded-xl bg-surface-1 px-3 py-1.5">
          <span className="min-w-0 flex-1 text-md text-foreground">Messages with no @ go to</span>
          <Select
            label="Lead"
            className="w-32 shrink-0"
            value={lead.key}
            options={picked.map((choice) => ({ value: choice.key, label: where(choice) }))}
            onValueChange={setAsked}
          />
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-4 text-ui text-destructive">
          {problem}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-3">
        {blocked && name.trim() && <span className="text-ui text-muted-foreground">{blocked}</span>}
        <Button
          type="submit"
          variant="primary"
          className="rounded-full"
          disabled={blocked !== undefined || saving}
          title={blocked}
        >
          {saving ? "Making…" : "Make group"}
        </Button>
      </div>
    </form>
  );
}
