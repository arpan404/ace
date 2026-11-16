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
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { botFileMax } from "./spade-bot-start.tsx";
import { importAgent } from "./spade-teams-api.ts";
import type { SpadeHost } from "./use-spade-roster.ts";

/* Spade's list top: Search, Spade's apps, plugins and skills, and +; then Spade's search field. */

/** A round 32px button, as Spade's list draws them: on the hover wash, `--active` on hover. */
const roundButton =
  "size-(--spade-round-button) rounded-full bg-hover hover:bg-active aria-expanded:bg-active";

/** The list's top: Search, Spade's own apps, plugins and skills, and +. */
export function SpadeListTop(props: {
  searching: boolean;
  onSearch(): void;
  hosts: readonly SpadeHost[];
  onNewBot(): void;
  onNewGroup(): void;
}) {
  return (
    <div className="mx-2 mt-1 mb-1 flex shrink-0 items-center justify-end gap-2 py-3.5 pr-2">
      <IconButton
        icon={MagnifyingGlassIcon}
        label="Search conversations"
        tip="Search"
        size="panel"
        aria-expanded={props.searching}
        onClick={props.onSearch}
        className={roundButton}
      />
      <Link
        to="/marketplace"
        search={{ type: "spade" }}
        aria-label="Apps, plugins and skills"
        title="Apps, plugins and skills"
        className={cn(
          "grid shrink-0 place-items-center text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground",
          roundButton,
        )}
      >
        <Icon icon={PuzzlePieceIcon} size={18} />
      </Link>
      {props.hosts.length > 0 && (
        <AddMenu hosts={props.hosts} onNewBot={props.onNewBot} onNewGroup={props.onNewGroup} />
      )}
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
    <div className="mx-2 mb-1.5 flex h-(--spade-pill-button) shrink-0 items-center gap-2 rounded-full bg-hover pr-1 pl-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
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
