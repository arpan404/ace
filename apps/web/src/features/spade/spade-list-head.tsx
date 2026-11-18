import {
  ArrowSquareInIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PuzzlePieceIcon,
  UserPlusIcon,
  UsersThreeIcon,
  XIcon,
} from "@ace/icons";
import { Link, useNavigate } from "@tanstack/react-router";
import { useOpenMarket } from "@/lib/open-market.ts";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { botFileMax } from "./spade-bot-start.tsx";
import { DottedFace, faceDotOf, livePose, type FaceDot } from "./spade-list-parts.tsx";
import type { SpadeListEntry } from "./spade-list-rows.ts";
import { SpadeRowMenu } from "./spade-row-menu.tsx";
import { importAgent } from "./spade-teams-api.ts";
import { useFaceState } from "./use-face-state.ts";
import type { SpadeHost } from "./use-spade-roster.ts";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/* Spade's list head: the main bot, Search, Spade's apps, plugins and skills, and +. */

/** A round 32px button, as Spade's list draws them: on the hover wash, `--active` on hover. */
const roundButton =
  "size-(--spade-round-button) rounded-full bg-hover hover:bg-active aria-expanded:bg-active";

/** The main bot's entry in the list. */
export type MainEntry = Extract<SpadeListEntry, { kind: "bot" }>;

/**
 * The list's head (docs/design/spade.md §2): the main bot in place of a title row, its face
 * carrying its state, its name, then Search, Spade's apps and +. Searching, the field takes the
 * head's place at the same height, so the rows below never move. Before the roster names a main
 * bot (Spade off, or starting) the head is Spade's own mark and name, with the dot Spade's state.
 */
export function SpadeListHead(props: {
  main: MainEntry | undefined;
  /** What the dot shows while no main bot is known: off, or failed. */
  idleDot: FaceDot | undefined;
  current: boolean;
  searching: boolean;
  query: string;
  onQuery(query: string): void;
  onSearch(): void;
  onCloseSearch(): void;
  hosts: readonly SpadeHost[];
  onNewBot(): void;
  onNewGroup(): void;
}) {
  const openMarket = useOpenMarket();
  const marketplace = useBetaEnabled("marketplace") === true;
  const main = props.main?.bot;
  const state = props.main?.row.state ?? "rest";
  const pose = useFaceState(main ? livePose(main, state) : null, props.current);
  const face = (
    <>
      <DottedFace
        avatar={main?.avatar ?? { kind: "spade" }}
        size={44}
        state={pose}
        dot={main ? faceDotOf(state) : props.idleDot}
        dim={main ? state === "off" : props.idleDot === "off"}
        large
      />
      <span
        data-view-row-title=""
        className="min-w-0 truncate text-lg/6 font-semibold text-foreground"
      >
        {main?.name ?? "Spade"}
      </span>
    </>
  );
  const link = "flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 pr-1 focus-ring";
  return (
    <div className="mx-2 mt-1 mb-1 flex h-17 shrink-0 items-center gap-2 pr-2 pl-2.5">
      {props.searching ? (
        <SpadeListSearch
          query={props.query}
          onQuery={props.onQuery}
          onClose={props.onCloseSearch}
        />
      ) : (
        <>
          {main && props.main ? (
            <SpadeRowMenu entry={props.main}>
              <Link
                to="/spade/$agentId"
                params={{ agentId: main.id }}
                search={main.machine.primary ? {} : { on: main.machine.key }}
                aria-current={props.current ? "page" : undefined}
                className={link}
              >
                {face}
              </Link>
            </SpadeRowMenu>
          ) : (
            <Link to="/spade" className={link}>
              {face}
            </Link>
          )}
          <IconButton
            icon={MagnifyingGlassIcon}
            label="Search conversations"
            tip="Search"
            size="panel"
            aria-expanded={false}
            onClick={props.onSearch}
            // The head's name may sit in a menu's wrapper: the buttons find the end themselves.
            className={cn(roundButton, "ml-auto")}
          />
          {marketplace && (
            <button
              type="button"
              onClick={() => openMarket("spade")}
              aria-label="Apps, plugins and skills"
              title="Apps, plugins and skills"
              className={cn(
                "grid shrink-0 place-items-center text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground",
                roundButton,
              )}
            >
              <Icon icon={PuzzlePieceIcon} size={18} />
            </button>
          )}
          {props.hosts.length > 0 && (
            <AddMenu hosts={props.hosts} onNewBot={props.onNewBot} onNewGroup={props.onNewGroup} />
          )}
        </>
      )}
    </div>
  );
}

/** Search, in place of the head: focused as it opens; Esc closes it and clears its words, as × does. */
export function SpadeListSearch(props: {
  query: string;
  onQuery(query: string): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  return (
    <div className="flex h-(--spade-pill-button) min-w-0 flex-1 items-center gap-2 rounded-full bg-hover pr-1 pl-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
      <Icon icon={MagnifyingGlassIcon} size={16} className="shrink-0 text-subtle-foreground" />
      <input
        ref={input}
        type="search"
        aria-label="Search conversations"
        placeholder="Search conversations"
        value={props.query}
        onChange={(event) => props.onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }}
        className="min-w-0 flex-1 bg-transparent text-md text-foreground placeholder:text-subtle-foreground focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      <IconButton
        icon={XIcon}
        label="Close search"
        size="sm"
        className="rounded-full"
        onClick={props.onClose}
      />
    </div>
  );
}

/**
 * + in the head: New bot, New group, and Import bot, which picks a bot file and sends it to this
 * machine's Spade (another machine's from New bot), then opens the bot.
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
            <IconButton
              icon={PlusIcon}
              label="New"
              tip="New bot, group or import"
              size="panel"
              className={roundButton}
            />
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
