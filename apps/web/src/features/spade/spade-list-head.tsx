import { botFaceStateOf } from "@ace/ui-core/bot-face";
import {
  ArrowSquareInIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserPlusIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useAccountPicture, useAceAccount } from "@/features/ace-account/index.ts";
import { cn } from "@/lib/cn.ts";
import { useProfileName } from "@/lib/profile.ts";
import { botFileMax } from "./spade-bot-start.tsx";
import { DottedFace, type FaceDot } from "./spade-list-parts.tsx";
import { importAgent } from "./spade-teams-api.ts";
import { useFaceState } from "./use-face-state.ts";
import type { RosterBot, SpadeHost } from "./use-spade-roster.ts";

/* Spade's list head (the main bot, Search and +) and its foot (the person and Spade settings). */

/** A round 32px button, as Spade's list draws them: on the hover wash, `--active` on hover. */
const roundButton =
  "size-(--spade-round-button) rounded-full bg-hover hover:bg-active aria-expanded:bg-active aria-pressed:bg-active";

/** The head's dot: amber while Spade needs the person, red when it failed, grey while it is off. */
function headDot(main: RosterBot | undefined, ready: boolean): FaceDot | undefined {
  if (!ready || !main || main.away || main.unavailable) return "off";
  if (main.state === "waiting") return "needs-you";
  if (main.state === "idle" && main.problem) return "failed";
  return undefined;
}

/**
 * The main bot in place of a title row: its 44px face, its name, then Search and +. It opens
 * Spade's conversation; while Spade isn't running here its face carries the grey dot (its
 * conversation says how to turn it on).
 */
export function SpadeListHead(props: {
  main: RosterBot | undefined;
  ready: boolean;
  current: boolean;
  searching: boolean;
  onSearch(): void;
  hosts: readonly SpadeHost[];
  onNewBot(): void;
  onNewGroup(): void;
}) {
  const { main } = props;
  const live = main && !main.away && !main.unavailable ? botFaceStateOf(main) : null;
  const pose = useFaceState(props.ready ? live : null, props.current);
  return (
    <div
      className={cn(
        "mx-2 mt-1 mb-1 flex shrink-0 items-center gap-2 rounded-lg py-3.5 pr-2 transition-colors duration-(--motion-fast)",
        "has-[a:hover]:bg-hover has-[a:hover]:[--row-wash:var(--hover)]",
        props.current && "bg-active [--row-wash:var(--active)] has-[a:hover]:bg-active",
      )}
    >
      <Link
        to={main ? "/spade/$agentId" : "/spade"}
        params={main ? { agentId: main.id } : {}}
        search={main && !main.machine.primary ? { on: main.machine.key } : {}}
        aria-current={props.current ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-lg pl-2.5 focus-ring-inset"
      >
        <DottedFace
          avatar={main?.avatar ?? { kind: "spade" }}
          size={44}
          state={pose}
          dot={headDot(main, props.ready)}
          large
        />
        <span
          data-view-row-title=""
          className="min-w-0 truncate text-lg/6 font-semibold tracking-title text-foreground"
        >
          {main?.name || "Spade"}
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        <IconButton
          icon={MagnifyingGlassIcon}
          label="Search conversations"
          tip="Search"
          size="panel"
          pressed={props.searching}
          onClick={props.onSearch}
          className={roundButton}
        />
        {props.hosts.length > 0 && (
          <AddMenu hosts={props.hosts} onNewBot={props.onNewBot} onNewGroup={props.onNewGroup} />
        )}
      </span>
    </div>
  );
}

/**
 * Search, in place over the rows: focused as it opens; Esc clears its words, then closes it, as
 * × does at once.
 */
export function SpadeListSearch(props: {
  query: string;
  onQuery(query: string): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  return (
    <div className="mx-2 mb-1.5 flex h-(--spade-pill-button) shrink-0 items-center gap-2 rounded-full bg-hover pr-1 pl-3 shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--ring)]">
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
          if (props.query) props.onQuery("");
          else props.onClose();
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

/**
 * The foot: the person (their picture or initials, and name) opens what the bots know about
 * them; the gear beside it opens Settings › Spade.
 */
export function SpadeListFoot() {
  const [profileName] = useProfileName();
  const { session } = useAceAccount();
  const picture = useAccountPicture();
  const name = session?.account.name || profileName;
  const shown = name.trim() || "You";
  return (
    <div className="flex h-15 shrink-0 items-center gap-2 pr-3 pl-2.5 shadow-[0_-1px_0_var(--border-soft)]">
      <Tip label="What your bots know about you">
        <Link
          to="/settings/spade"
          hash="about-you"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 transition-colors duration-(--motion-fast) focus-ring hover:bg-hover"
        >
          <ProfileAvatar name={name} picture={picture} className="size-8 text-ui" iconSize={16} />
          <span className="min-w-0 truncate text-md font-medium text-foreground">{shown}</span>
        </Link>
      </Tip>
      <Tip label="Spade settings">
        <Link
          to="/settings/spade"
          aria-label="Spade settings"
          className={cn(
            "grid shrink-0 place-items-center text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground",
            roundButton,
          )}
        >
          <Icon icon={GearSixIcon} size={18} />
        </Link>
      </Tip>
    </div>
  );
}
