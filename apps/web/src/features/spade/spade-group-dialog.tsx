import { spadeGroupNameMax } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import {
  choiceKey,
  groupChange,
  groupProblem,
  leadChoices,
  newGroupBody,
  orderChoices,
  spadeLeads,
  type MemberChoice,
} from "./group-draft.ts";
import { SpadeFace } from "./spade-face.tsx";
import { spadeMachineKey } from "./spade-machine.tsx";
import { createGroup, editGroup } from "./spade-teams-api.ts";
import { groupsKey, type RosterGroup } from "./use-spade-groups.ts";
import type { RosterBot, SpadeHost } from "./use-spade-roster.ts";

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/** Every roster bot as a member the form offers, with its machine's host id. */
function choicesOf(bots: readonly RosterBot[], machines: readonly Machine[]): MemberChoice[] {
  return bots.flatMap((bot) => {
    const machine = machines.find((each) => spadeMachineKey(each) === bot.machine.key);
    if (!machine) return [];
    return [
      {
        key: choiceKey(machine.id, bot.id),
        agent: bot.id,
        host: machine.id,
        name: bot.name,
        avatar: bot.avatar,
        machineName: machine.name,
        main: bot.kind === "main",
        away: bot.away || bot.unavailable,
      },
    ];
  });
}

/**
 * New group (ADR 0132): its name, the machine it lives on (its lead's), 2 to 8 member bots of
 * any machine (the group's machine's first) and its lead among members of that machine, Spade by
 * default. Creating it opens its conversation.
 */
export function NewGroupDialog(props: {
  hosts: readonly SpadeHost[];
  bots: readonly RosterBot[];
  onClose(): void;
}) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const machines = useMachines();
  const [hostKey, setHostKey] = useState(props.hosts[0]?.spade.key ?? "");
  const host = props.hosts.find((each) => each.spade.key === hostKey);
  const submit = async (body: ReturnType<typeof newGroupBody>) => {
    const client = host?.machine.client;
    if (!client || !host) throw new Error("That machine isn't reachable right now.");
    const group = await createGroup(client, body);
    await cache.invalidateQueries({ queryKey: groupsKey });
    props.onClose();
    void navigate({
      to: "/spade/groups/$groupId",
      params: { groupId: group.id },
      search: host.spade.primary ? {} : { on: host.spade.key },
    });
  };
  return (
    <GroupForm
      title="New group"
      confirm="Create group"
      groupHost={host?.machine.id ?? ""}
      choices={choicesOf(props.bots, machines)}
      initial={{ name: "", picked: [], lead: spadeLeads }}
      machine={
        <Select
          label="Lives on"
          value={hostKey}
          options={props.hosts.map((each) => ({
            value: each.spade.key,
            label: each.machine.primary ? `${each.machine.name} (this machine)` : each.machine.name,
          }))}
          onValueChange={setHostKey}
          className="w-72"
        />
      }
      onClose={props.onClose}
      onSave={(name, picked, lead) =>
        submit(newGroupBody(name, picked, lead, host?.machine.id ?? ""))
      }
    />
  );
}

/** Edit a group on its machine: its name, members and lead, sent as one change of what moved. */
export function EditGroupDialog(props: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  client: NonNullable<Machine["client"]>;
  onClose(): void;
}) {
  const { group } = props;
  const cache = useQueryClient();
  const machines = useMachines();
  const choices = choicesOf(props.bots, machines);
  // Members whose bot the roster doesn't list (a machine out of reach) stay as the group has them.
  const picked = group.members.map(
    (member): MemberChoice =>
      choices.find(
        (choice) => choice.agent === member.agent && choice.host === (member.machine ?? group.host),
      ) ?? {
        key: choiceKey(member.machine ?? group.host, member.agent),
        agent: member.agent,
        host: member.machine ?? group.host,
        name: member.name,
        avatar: member.avatar,
        machineName: "",
        main: false,
        away: true,
      },
  );
  const leadIsSpade = picked.some((choice) => choice.main && choice.agent === group.lead.agent);
  const before = {
    name: group.name,
    members: group.members.map((member) =>
      member.machine === null
        ? { agent: member.agent }
        : { agent: member.agent, machine: member.machine },
    ),
    lead: group.lead.agent,
  };
  return (
    <GroupForm
      title={`Edit ${group.name}`}
      confirm="Save"
      groupHost={group.host}
      choices={[...choices, ...picked.filter((choice) => !choices.includes(choice))]}
      initial={{ name: group.name, picked, lead: leadIsSpade ? spadeLeads : group.lead.agent }}
      onClose={props.onClose}
      onSave={async (name, chosen, lead) => {
        const change = groupChange(before, newGroupBody(name, chosen, lead, group.host));
        if (Object.keys(change).length > 0) await editGroup(props.client, group.id, change);
        await cache.invalidateQueries({ queryKey: groupsKey });
        props.onClose();
      }}
    />
  );
}

function Field(props: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.htmlFor} className="w-fit text-ui font-medium">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

function GroupForm(props: {
  title: string;
  confirm: string;
  groupHost: string;
  choices: readonly MemberChoice[];
  initial: { name: string; picked: readonly MemberChoice[]; lead: string };
  machine?: ReactNode;
  onClose(): void;
  onSave(name: string, picked: readonly MemberChoice[], lead: string): Promise<void>;
}) {
  const ids = { name: useId(), lead: useId() };
  const [name, setName] = useState(props.initial.name);
  const [keys, setKeys] = useState(() => props.initial.picked.map((choice) => choice.key));
  const [lead, setLead] = useState(props.initial.lead);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const ordered = orderChoices(props.choices, props.groupHost);
  // In the order the person picked them: the group keeps that order.
  const picked = keys.flatMap((key) => ordered.filter((choice) => choice.key === key));
  const leads = leadChoices(picked, props.groupHost);
  const leader = leads.some((choice) => choice.value === lead) ? lead : spadeLeads;
  const blocked = groupProblem(name, picked, leader);
  const save = async () => {
    if (blocked) return;
    setSaving(true);
    setProblem(undefined);
    try {
      await props.onSave(name, picked, leader);
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field label="Name" htmlFor={ids.name}>
            <Input
              id={ids.name}
              value={name}
              maxLength={spadeGroupNameMax}
              onChange={(event) => setName(event.target.value.replaceAll(/[\r\n]/g, " "))}
            />
          </Field>
          {props.machine && <Field label="Lives on">{props.machine}</Field>}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-ui font-medium">Members</legend>
            <ul className="flex max-h-64 flex-col overflow-y-auto">
              {ordered.map((choice) => (
                <li key={choice.key}>
                  <MemberOption
                    choice={choice}
                    other={choice.host !== props.groupHost}
                    checked={keys.includes(choice.key)}
                    onChange={(on) =>
                      setKeys((now) =>
                        on ? [...now, choice.key] : now.filter((key) => key !== choice.key),
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </fieldset>
          <Field label="Lead" htmlFor={ids.lead}>
            <Select
              id={ids.lead}
              label="Lead"
              value={leader}
              options={leads}
              onValueChange={setLead}
              className="w-72"
            />
          </Field>
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={blocked !== undefined || saving}
            title={blocked}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : props.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberOption(props: {
  choice: MemberChoice;
  other: boolean;
  checked: boolean;
  onChange(on: boolean): void;
}) {
  const { choice } = props;
  return (
    <div className="flex h-9 items-center gap-2.5 rounded-md px-1.5 text-ui">
      <Checkbox
        checked={props.checked}
        onCheckedChange={(on) => props.onChange(on === true)}
        aria-label={props.other ? `${choice.name} on ${choice.machineName}` : choice.name}
      />
      <SpadeFace avatar={choice.avatar} size={20} className={choice.away ? "opacity-45" : ""} />
      <span className="min-w-0 flex-1 truncate">{choice.name}</span>
      {props.other && choice.machineName && (
        <span className="shrink-0 text-xs text-subtle-foreground">{choice.machineName}</span>
      )}
    </div>
  );
}
