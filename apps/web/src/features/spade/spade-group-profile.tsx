import { spadeGroupMembersMax, spadeGroupMembersMin } from "@ace/ui-core/spade-chat";
import { formatAge } from "@ace/ui-core/time";
import { CaretLeftIcon, XIcon } from "@ace/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachines } from "@/lib/machines.ts";
import { useNow } from "@/lib/time.ts";
import {
  choicesOf,
  groupAsIs,
  groupChange,
  hostSpade,
  leadChoices,
  memberChoices,
  newGroupBody,
  orderChoices,
  spadeLeads,
  type MemberChoice,
} from "./group-draft.ts";
import { botSearch } from "./spade-bot-screen.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { GroupFaces } from "./spade-group-faces.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { message, Problem } from "./spade-screen-parts.tsx";
import { deleteGroup, editGroup, readGroupFiles, type SpadeGroupDraft } from "./spade-teams-api.ts";
import { groupsKey, shownMembers, type RosterGroup } from "./use-spade-groups.ts";
import type { RosterBot } from "./use-spade-roster.ts";

type Tab = "members" | "library";

/**
 * A group's profile in the side panel (docs/design/spade.md §4, §5): its stacked faces and its
 * name, renamed in place, then Members (who is in it, Add and Remove, and the lead, who answers
 * what has no @) and Library (the files its members made answering it, each opening in its
 * member's files). A group has no computer of its own. Delete asks once and keeps the bots.
 */
export function GroupProfile(props: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  /** It covers the chat: its way back reads Chat. */
  covering: boolean;
  onClose(): void;
}) {
  const { group } = props;
  const [tab, setTab] = useState<Tab>("members");
  const save = useGroupSave(group);
  const machines = useMachines();
  const members = shownMembers(machines, group, props.bots);
  return (
    <div className="flex h-full min-h-0 flex-col [--faces-cut:var(--panel)]">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {props.covering && (
          <Button size="sm" variant="ghost" onClick={props.onClose} className="-ml-1 gap-1">
            <Icon icon={CaretLeftIcon} size={14} />
            Chat
          </Button>
        )}
        <span className="flex-1" />
        {!props.covering && (
          <IconButton
            icon={XIcon}
            label="Close profile"
            size="panel"
            onClick={props.onClose}
            className="size-(--spade-round-button) rounded-full bg-hover hover:bg-active"
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <header className="flex flex-col items-center gap-3 pt-2 pb-5">
          <GroupFaces members={members} size={96} />
          <GroupName name={group.name} onRename={(name) => save({ name })} />
        </header>
        <SegmentedControl<Tab>
          label="Profile"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "members", label: "Members" },
            { value: "library", label: "Library" },
          ]}
          className="mb-5 w-full"
        />
        {tab === "members" ? (
          <MembersTab group={group} bots={props.bots} save={save} />
        ) : (
          <LibraryTab group={group} bots={props.bots} />
        )}
      </div>
    </div>
  );
}

/** Sends one change to the group and reads the groups again; says so when Spade refuses it. */
function useGroupSave(group: RosterGroup) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  return async (change: Partial<SpadeGroupDraft>) => {
    if (Object.keys(change).length === 0) return true;
    try {
      await editGroup(client, group.id, change);
      await cache.invalidateQueries({ queryKey: groupsKey });
      return true;
    } catch (error) {
      toast.error({ title: `Couldn't change ${group.name}`, description: message(error) });
      return false;
    }
  };
}

/** The name, a button that becomes its field: ↵ saves, Esc puts it back. */
function GroupName(props: { name: string; onRename(name: string): Promise<boolean> }) {
  const [draft, setDraft] = useState<string>();
  if (draft === undefined)
    return (
      <button
        type="button"
        onClick={() => setDraft(props.name)}
        aria-label={`Rename ${props.name}`}
        className="max-w-full truncate rounded-md px-2.5 py-0.5 text-[22px] leading-7 font-semibold text-foreground focus-ring hover:bg-hover"
      >
        {props.name}
      </button>
    );
  const done = () => setDraft(undefined);
  const commit = () => {
    const name = draft.replaceAll(/[\r\n]/g, " ").trim();
    if (!name || name === props.name) return done();
    void props.onRename(name).then((saved) => saved && done());
  };
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person just asked to rename it
      autoFocus
      aria-label="Group name"
      value={draft}
      maxLength={60}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
          event.preventDefault();
          done();
        }
      }}
      className="w-full max-w-80 rounded-md bg-(--chat-well) px-2.5 py-0.5 text-center text-[22px] leading-7 font-semibold text-foreground outline-none focus-ring"
    />
  );
}

function Section(props: { label: string; children: ReactNode }) {
  return (
    <section className="mb-6 flex flex-col">
      <h3 className="mb-1.5 ml-3 text-ui font-medium text-muted-foreground">{props.label}</h3>
      <div className="flex flex-col rounded-xl bg-surface-1 p-1">{props.children}</div>
    </section>
  );
}

const row = "flex min-h-12 items-center gap-3 rounded-lg px-3 py-1.5";

/** Members, each Removable but the lead, Add a member, and who answers what has no @. */
function MembersTab(props: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  save(change: Partial<SpadeGroupDraft>): Promise<boolean>;
}) {
  const { group } = props;
  const machines = useMachines();
  const choices = choicesOf(props.bots, machines);
  const picked = memberChoices(group, choices);
  const shown = shownMembers(machines, group, props.bots);
  const spade = hostSpade(choices, group.host);
  const leadIsSpade = picked.some((choice) => choice.main && choice.agent === group.lead.agent);
  const lead = leadIsSpade ? spadeLeads : group.lead.agent;
  const leads = leadChoices(picked, group.host, spade);
  const others = orderChoices(
    choices.filter((choice) => !picked.some((member) => member.key === choice.key)),
    group.host,
  );
  const send = (next: readonly MemberChoice[], nextLead: string) =>
    props.save(
      groupChange(groupAsIs(group), newGroupBody(group.name, next, nextLead, group.host, spade)),
    );
  const full = picked.length >= spadeGroupMembersMax;
  return (
    <>
      <Section label="Members">
        {picked.map((choice, index) => {
          const member = shown[index];
          const isLead = choice.agent === group.lead.agent && choice.host === group.host;
          const elsewhere = choice.host !== group.host;
          return (
            <div key={choice.key} className={row}>
              <SpadeFace
                avatar={member?.avatar ?? choice.avatar}
                size={32}
                className={member?.away ? "opacity-45" : undefined}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-md font-medium text-foreground">
                  {member?.name ?? choice.name}
                </span>
                <span className="truncate text-ui text-muted-foreground">
                  {isLead
                    ? "Lead · answers what has no @"
                    : member?.away
                      ? "Away"
                      : elsewhere
                        ? choice.machineName
                        : (machines.find((machine) => machine.id === group.host)?.name ?? "")}
                </span>
              </div>
              {!isLead && picked.length > spadeGroupMembersMin && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${member?.name ?? choice.name}`}
                  onClick={() =>
                    void send(
                      picked.filter((other) => other.key !== choice.key),
                      lead,
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          );
        })}
        {!full && others.length > 0 && (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={`${row} text-left text-md text-foreground focus-ring hover:bg-hover`}
                >
                  Add a member
                </button>
              }
            />
            <MenuContent align="start">
              {others.map((choice) => (
                <MenuItem
                  key={choice.key}
                  icon={<SpadeFace avatar={choice.avatar} size={20} />}
                  onClick={() => void send([...picked, choice], lead)}
                >
                  {choice.host === group.host
                    ? choice.name
                    : `${choice.name} on ${choice.machineName}`}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
      </Section>
      <Section label="Lead">
        <div className={row}>
          <span className="min-w-0 flex-1 text-md text-foreground">Messages with no @ go to</span>
          <Select
            label="Lead"
            className="w-32 shrink-0"
            value={lead}
            options={leads}
            onValueChange={(next) => void send(picked, next)}
          />
        </div>
      </Section>
      <DeleteGroup group={group} />
    </>
  );
}

function DeleteGroup(props: { group: RosterGroup }) {
  const { group } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const remove = async () => {
    try {
      await deleteGroup(client, group.id);
      await cache.invalidateQueries({ queryKey: groupsKey });
      void navigate({ to: "/spade", replace: true });
    } catch (error) {
      toast.error({ title: `Couldn't delete ${group.name}`, description: message(error) });
    }
  };
  return (
    <div className="flex justify-end">
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={() =>
          setConfirming({
            title: `Delete ${group.name}?`,
            body: `This deletes ${group.name} and its conversation. Its bots stay.`,
            confirm: "Delete group",
            run: () => void remove(),
          })
        }
      >
        Delete group…
      </Button>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );
}

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** The files the group's members made answering it, newest first; each opens in its member's files. */
function LibraryTab(props: { group: RosterGroup; bots: readonly RosterBot[] }) {
  const { group } = props;
  const client = useSpadeClient();
  const navigate = useNavigate();
  const now = useNow();
  const files = useQuery({
    queryKey: [...groupsKey, group.machine.key, group.id, "files"],
    queryFn: ({ signal }) => readGroupFiles(client, group.id, { signal }),
  });
  if (files.isError)
    return <Problem text="Couldn't read the group's files." onRetry={() => void files.refetch()} />;
  if (!files.data)
    return (
      <Section label="Files">
        <Skeleton className="m-2 h-8 rounded-md" />
        <Skeleton className="m-2 h-8 rounded-md" />
      </Section>
    );
  if (files.data.length === 0)
    return (
      <p className="px-3 text-ui text-muted-foreground">
        Files the members make in this group show here.
      </p>
    );
  return (
    <Section label="Files">
      {files.data.map((file) => {
        const bot = props.bots.find(
          (candidate) => candidate.id === file.agent && candidate.machine.key === group.machine.key,
        );
        const name = fileName(file.path);
        const open = bot
          ? () =>
              void navigate({
                to: "/spade/$agentId",
                params: { agentId: bot.id },
                search: botSearch(bot, {
                  computer: "files",
                  files: file.path.split("/").slice(0, -1).join("/"),
                  file: file.path,
                }),
              })
          : undefined;
        return (
          <button
            key={`${file.agent}/${file.path}`}
            type="button"
            disabled={!open}
            onClick={open}
            title={file.path}
            aria-label={bot ? `${name}, by ${bot.name}` : name}
            className={`${row} min-h-10 text-left focus-ring enabled:hover:bg-hover`}
          >
            {bot && <SpadeFace avatar={bot.avatar} size={20} />}
            <span className="min-w-0 flex-1 truncate text-md text-foreground">{name}</span>
            <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
              {formatAge(file.at, now)}
            </span>
          </button>
        );
      })}
    </Section>
  );
}
