import { botFaceStateOf } from "@ace/ui-core/bot-face";
import { formatAge } from "@ace/ui-core";
import {
  spadeCappedLine,
  spadeGroupLine,
  spadeLiveSurfaces,
  spadeProblemStep,
  spadeSetupSentence,
  spadeStateLine,
  spadeSurfaceNames,
} from "@ace/ui-core/spade-chat";
import {
  ArrowSquareInIcon,
  DesktopIcon,
  PlusIcon,
  UserPlusIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { PanelTitleSearch } from "@/components/ui/panel-title-search.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { ViewSidebarError } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { useMachines } from "@/lib/machines.ts";
import { useNow } from "@/lib/time.ts";
import { surfaceIcons } from "./computer/computer-view.tsx";
import { NewBotDialog } from "./spade-bot-dialog.tsx";
import { botFileMax } from "./spade-bot-start.tsx";
import { filterSpadeList, spadeListCounts, type SpadeListFilter } from "./spade-list-filter.ts";
import { importAgent } from "./spade-teams-api.ts";
import { GroupFaces } from "./spade-group-faces.tsx";
import { NewGroupDialog } from "./spade-group-dialog.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { useFaceState } from "./use-face-state.ts";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useOneSpade, useSpadeRoster, type RosterBot, type SpadeHost } from "./use-spade-roster.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useTellZone } from "./use-spade-zone.ts";
import {
  rosterEntries,
  shownMembers,
  useSpadeGroups,
  type RosterGroup,
} from "./use-spade-groups.ts";

/** The second line of a bot's row: what it does now, a cap it is at, else its latest message. */
export function rosterLine(bot: RosterBot): { text: string; tone?: "working" | "needs-you" } {
  if (bot.away) return { text: `Away · ${bot.machine.name} is offline` };
  if (bot.unavailable) return { text: `Unavailable · Spade isn't running on ${bot.machine.name}` };
  if (bot.state === "waiting" && bot.waitingFor === "question")
    return { text: "Asked you a question", tone: "needs-you" };
  if (bot.state === "waiting") return { text: bot.status ?? "Waiting for you", tone: "needs-you" };
  if (bot.state === "working") return { text: bot.status ?? "Working", tone: "working" };
  // A subscription that couldn't run (signed out, out of quota) until a later reply works: the
  // next step in a few words; the reason and its action are in the conversation.
  if (bot.problem) return { text: spadeProblemStep(bot.problem), tone: "needs-you" };
  // At a cap it makes no model call until the cap ends (ADR 0135).
  if (bot.spending?.capped) return { text: spadeCappedLine(bot.spending.capped) };
  const last = bot.lastMessage;
  if (!last?.text) return { text: "No messages yet" };
  if (last.from === "agent") return { text: last.text };
  return { text: `${last.fromAgent ? last.fromAgent.name : "You"}: ${last.text}` };
}

/**
 * Spade's panel, a messenger's list (ADR 0127): Spade first, then every bot on every machine
 * this window reaches by latest activity. Its header: a filter naming what the list shows (All
 * bots, Working, Needs you, one machine, with counts), then + (New bot, New group, Import bot)
 * and Search, which opens over the header and finds bots by name or by what they said. A row is
 * the bot's face, its name, what it uses on its computer now and when it was last active, then
 * what it does now in its state's colour (or its latest message), ending with its machine when
 * that isn't this one. A bot on an offline machine reads as away, one whose Spade stopped as
 * unavailable. While Spade isn't running, its state in one sentence (with Turn on while it is
 * off), and while it runs but waits on the person (a keychain prompt), what to look for. The
 * panel sees every machine, so it keeps Spade, the main bot, on one (`useOneSpade`).
 */
export function SpadeSidebar() {
  const status = useSpadeStatus();
  const [enabled] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  // Running but waiting on the person (a keychain prompt): said in the same quiet line.
  const setup = spadeSetupSentence(status);
  const roster = useSpadeRoster(line.ready);
  useOneSpade(roster.hosting);
  useTellZone(useMemo(() => roster.hosts.map((host) => host.machine.client), [roster.hosts]));
  const { groups } = useSpadeGroups(roster);
  const [filter, setFilter] = useState<SpadeListFilter>("all");
  const [query, setQuery] = useState("");
  const entries = filterSpadeList(rosterEntries(roster.bots, groups), filter, query);
  const open = useParams({
    strict: false,
    select: (params) => params.agentId ?? params.groupId,
  });
  const now = useNow();
  const [creating, setCreating] = useState<"bot" | "group">();
  const counts = spadeListCounts(roster.bots);
  const machines = [
    ...new Map(roster.bots.map((bot) => [bot.machine.key, bot.machine.name])).entries(),
  ];
  const options = [
    // The chosen filter names the list on its own; the menu's other states carry their counts.
    { value: "all" as const, label: "All bots", count: filter === "all" ? undefined : counts.all },
    {
      value: "working" as const,
      label: "Working",
      count: filter === "working" ? undefined : counts.working,
    },
    {
      value: "needs-you" as const,
      label: "Needs you",
      count: filter === "needs-you" ? undefined : counts.needsYou,
    },
    // One machine's bots, once there is more than one machine.
    ...(machines.length > 1
      ? machines.map(([key, name]) => ({
          value: `machine:${key}` as const,
          label: name,
          icon: <Icon icon={DesktopIcon} size={14} />,
        }))
      : []),
  ];
  return (
    <ViewSidebar
      toolbar={
        <>
          <PanelTitleSearch
            title="Bots"
            label="Search bots and messages"
            query={query}
            onQuery={setQuery}
            lead={
              <FilterMenu<SpadeListFilter>
                label="Show"
                align="start"
                value={filter}
                options={options}
                onValueChange={setFilter}
              />
            }
            actions={
              roster.hosts.length > 0 && (
                <AddMenu
                  hosts={roster.hosts}
                  onNewBot={() => setCreating("bot")}
                  onNewGroup={() => setCreating("group")}
                />
              )
            }
          />
          {!line.ready ? (
            <SpadeStateStrip line={line} />
          ) : setup ? (
            <SpadeStateStrip line={{ ...line, sentence: setup }} />
          ) : null}
        </>
      }
    >
      <nav aria-label="Bots">
        {/* The last list stays while Spade restarts or a read fails; it reads again on its own. */}
        {!roster.bots.length && !line.ready ? null : !roster.bots.length && roster.error ? (
          <ViewSidebarError onRetry={roster.refetch} />
        ) : !roster.bots.length && roster.loading ? (
          <ListSkeleton label="bots" shape="thread" />
        ) : entries.length === 0 && (query || filter !== "all") ? (
          <p className="px-2.5 pt-2 text-ui text-muted-foreground">
            {query ? `Nothing matches “${query.trim()}”.` : "No bots here right now."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {entries.map((entry) =>
              entry.kind === "bot" ? (
                <li key={`${entry.bot.machine.key}/${entry.bot.id}`}>
                  <Row bot={entry.bot} current={open === entry.bot.id} now={now} />
                </li>
              ) : (
                <li key={`group:${entry.group.machine.key}/${entry.group.id}`}>
                  <GroupRow
                    group={entry.group}
                    bots={roster.bots}
                    current={open === entry.group.id}
                    now={now}
                  />
                </li>
              ),
            )}
          </ul>
        )}
      </nav>
      {creating === "bot" && (
        <NewBotDialog hosts={roster.hosts} onClose={() => setCreating(undefined)} />
      )}
      {creating === "group" && (
        <NewGroupDialog
          hosts={roster.hosts}
          bots={roster.bots}
          onClose={() => setCreating(undefined)}
        />
      )}
    </ViewSidebar>
  );
}

/**
 * + in the list's header: New bot, New group, and Import bot, which picks a bot file and sends it
 * to this machine's Spade (another machine's from New bot), then opens the bot.
 */
function AddMenu(props: { hosts: readonly SpadeHost[]; onNewBot(): void; onNewGroup(): void }) {
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const host = props.hosts[0];
  const take = async (picked: File | undefined) => {
    const client = host?.machine.client;
    if (!picked || !host || !client) return;
    if (picked.size > botFileMax) {
      toast.error({ title: "That file is too big for a bot file (6 MB at most)." });
      return;
    }
    try {
      const answer = await importAgent(client, await picked.text());
      if (answer.leftOut.length)
        toast.info({
          title: `Imported ${answer.agent.name}`,
          description: answer.leftOut.join(" "),
        });
      void navigate({
        to: "/spade/$agentId",
        params: { agentId: answer.agent.id },
        search: host.spade.primary ? {} : { on: host.spade.key },
      });
    } catch (error) {
      toast.error({
        title: "Couldn't import the bot",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <IconButton icon={PlusIcon} label="New" tip="New bot, group or import" size="panel" />
          }
        />
        <MenuContent align="end">
          <MenuItem icon={<Icon icon={UserPlusIcon} size={16} />} onClick={props.onNewBot}>
            New bot
          </MenuItem>
          <MenuItem icon={<Icon icon={UsersThreeIcon} size={16} />} onClick={props.onNewGroup}>
            New group
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Icon icon={ArrowSquareInIcon} size={16} />}
            onClick={() => file.current?.click()}
          >
            Import bot…
          </MenuItem>
        </MenuContent>
      </Menu>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        aria-label="Bot file to import"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          void take(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </>
  );
}

function Row(props: { bot: RosterBot; current: boolean; now: number }) {
  const { bot } = props;
  const line = rosterLine(bot);
  // Its face is its status: still while away, moving only while it works.
  const state = useFaceState(
    bot.away || bot.unavailable ? null : botFaceStateOf(bot),
    props.current,
  );
  return (
    <Link
      to="/spade/$agentId"
      params={{ agentId: bot.id }}
      search={bot.machine.primary ? {} : { on: bot.machine.key }}
      aria-current={props.current ? "page" : undefined}
      data-panel-row=""
      className="flex h-14 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover aria-[current=page]:bg-active"
    >
      <SpadeFace
        avatar={bot.avatar}
        size={32}
        state={state}
        ring="bg-(--sidebar-panel) shadow-[0_0_0_2px_var(--sidebar-panel)]"
        className={cn((bot.away || bot.unavailable) && "opacity-45")}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            data-view-row-title=""
            className={cn(
              "min-w-0 flex-1 truncate text-md",
              bot.away || bot.unavailable ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {bot.name}
          </span>
          <SurfaceMarks bot={bot} />
          <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
            {formatAge(bot.lastActivity, props.now)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span
            data-tone={line.tone}
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              line.tone ? "text-(--tone-text)" : "text-subtle-foreground",
            )}
          >
            {line.text}
          </span>
          {/* A bot on another machine says which, at the line's end. */}
          {!bot.machine.primary && (
            <span className="flex max-w-[45%] shrink-0 items-center gap-1 text-xs text-subtle-foreground">
              <Icon icon={DesktopIcon} size={12} className="shrink-0" />
              <span className="truncate">{bot.machine.name}</span>
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

/** What the bot uses on its computer now: a globe, a screen, a terminal. */
function SurfaceMarks(props: { bot: RosterBot }) {
  if (props.bot.away || props.bot.unavailable) return null;
  const live = spadeLiveSurfaces(props.bot.computer);
  if (!live.length) return null;
  return (
    <span
      data-tone="working"
      role="img"
      aria-label={`Using its ${live.map((surface) => spadeSurfaceNames[surface.kind].toLowerCase()).join(" and ")}`}
      className="flex shrink-0 items-center gap-1 self-center text-(--tone-text)"
    >
      {live.map((surface) => (
        <Icon key={surface.kind} icon={surfaceIcons[surface.kind]} size={13} />
      ))}
    </span>
  );
}

/** The second line of a group's row: like a bot's, away or unavailable with its machine. */
function groupLine(group: RosterGroup): { text: string; tone?: "working" | "needs-you" } {
  if (group.away) return { text: `Away · ${group.machine.name} is offline` };
  if (group.unavailable)
    return { text: `Unavailable · Spade isn't running on ${group.machine.name}` };
  return spadeGroupLine(group);
}

/**
 * A group's row: up to three members' faces stacked, its name and when it was last active, then
 * what it does now in its state's colour, or its latest message with who said it.
 */
function GroupRow(props: {
  group: RosterGroup;
  bots: readonly RosterBot[];
  current: boolean;
  now: number;
}) {
  const { group } = props;
  const machines = useMachines();
  const members = shownMembers(machines, group, props.bots);
  const line = groupLine(group);
  return (
    <Link
      to="/spade/groups/$groupId"
      params={{ groupId: group.id }}
      search={group.machine.primary ? {} : { on: group.machine.key }}
      aria-current={props.current ? "page" : undefined}
      data-panel-row=""
      className="flex h-14 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover aria-[current=page]:bg-active"
    >
      <span className={cn("flex shrink-0", (group.away || group.unavailable) && "opacity-45")}>
        <GroupFaces members={members} size={32} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span data-view-row-title="" className="min-w-0 flex-1 truncate text-md text-foreground">
            {group.name}
          </span>
          <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
            {formatAge(group.lastActivity, props.now)}
          </span>
        </span>
        <span
          data-tone={line.tone}
          className={cn(
            "truncate text-xs",
            line.tone ? "text-(--tone-text)" : "text-subtle-foreground",
          )}
        >
          {line.text}
        </span>
      </span>
    </Link>
  );
}
