import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useMachines } from "@/lib/machines.ts";
import { DottedFace, faceDotOf, livePose } from "./spade-list-parts.tsx";
import { GroupFaces } from "./spade-group-faces.tsx";
import type { SpadeListEntry, SpadeRowState } from "./spade-list-rows.ts";
import { SpadeRowMenu } from "./spade-row-menu.tsx";
import { shownMembers } from "./use-spade-groups.ts";
import { useFaceState } from "./use-face-state.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/*
 * The pinned conversations (docs/design/spade.md §2): one face each under the list's buttons,
 * with the name beneath, oldest pin first. The strip scrolls sideways, with no scrollbar. A face
 * keeps its dot (needs you, failed); the rows below leave out what is pinned.
 */

const tile =
  "group/row flex w-16 shrink-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:[--row-wash:var(--hover)] aria-[current=page]:bg-active aria-[current=page]:[--row-wash:var(--active)]";

function Name(props: { name: string; state: SpadeRowState }) {
  return (
    <span
      data-view-row-title=""
      className={cn(
        "w-full truncate text-center text-xs/4",
        props.state === "unseen" ? "font-semibold text-foreground" : "text-muted-foreground",
      )}
    >
      {props.name}
    </span>
  );
}

function BotTile(props: { bot: RosterBot; state: SpadeRowState; current: boolean }) {
  const { bot } = props;
  const pose = useFaceState(livePose(bot, props.state), props.current);
  return (
    <Link
      to="/spade/$agentId"
      params={{ agentId: bot.id }}
      search={bot.machine.primary ? {} : { on: bot.machine.key }}
      aria-current={props.current ? "page" : undefined}
      aria-label={bot.name}
      className={tile}
    >
      <DottedFace
        avatar={bot.avatar}
        size={40}
        state={pose}
        dot={faceDotOf(props.state)}
        dim={props.state === "off"}
      />
      <Name name={bot.name} state={props.state} />
    </Link>
  );
}

export function SpadePinStrip(props: {
  entries: readonly SpadeListEntry[];
  bots: readonly RosterBot[];
  open: string | undefined;
}) {
  const machines = useMachines();
  return (
    <ul
      aria-label="Pinned"
      className="no-scrollbar mx-2 mb-1 flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain px-0.5"
    >
      {props.entries.map((entry) =>
        entry.kind === "bot" ? (
          <li key={`${entry.bot.machine.key}/${entry.bot.id}`} className="shrink-0">
            <SpadeRowMenu entry={entry}>
              <BotTile
                bot={entry.bot}
                state={entry.row.state}
                current={props.open === entry.bot.id}
              />
            </SpadeRowMenu>
          </li>
        ) : (
          <li key={`group:${entry.group.machine.key}/${entry.group.id}`} className="shrink-0">
            <SpadeRowMenu entry={entry}>
              <Link
                to="/spade/groups/$groupId"
                params={{ groupId: entry.group.id }}
                search={entry.group.machine.primary ? {} : { on: entry.group.machine.key }}
                aria-current={props.open === entry.group.id ? "page" : undefined}
                aria-label={entry.group.name}
                className={tile}
              >
                <span className={cn("flex", entry.row.state === "off" && "opacity-45")}>
                  <GroupFaces members={shownMembers(machines, entry.group, props.bots)} size={40} />
                </span>
                <Name name={entry.group.name} state={entry.row.state} />
              </Link>
            </SpadeRowMenu>
          </li>
        ),
      )}
    </ul>
  );
}
