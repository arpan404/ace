import { spadeSetupSentence, spadeStateLine } from "@ace/ui-core/spade-chat";
import { PlusIcon } from "@ace/icons";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SpadeListHead, type MainEntry } from "./spade-list-head.tsx";
import { SpadeListFoot } from "./spade-list-foot.tsx";
import { BotListRow, GroupListRow, ListSkeletonRows } from "./spade-list-parts.tsx";
import { SpadePinStrip } from "./spade-pin-strip.tsx";
import { SpadeRowMenu } from "./spade-row-menu.tsx";
import {
  searchSpadeList,
  type SpadeListEntry,
  spadeFlatEntries,
  spadeListEntries,
  splitPinned,
} from "./spade-list-rows.ts";
import { Problem } from "./spade-screen-parts.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useOneSpade, useSpadeRoster } from "./use-spade-roster.ts";
import { useGoalMissing } from "./use-goal-missing.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useTellZone } from "./use-spade-zone.ts";
import { useSpadeGroups } from "./use-spade-groups.ts";

const isMain = (entry: SpadeListEntry) => entry.kind === "bot" && entry.bot.kind === "main";

/**
 * Spade's panel, a messenger's list (ADR 0127, docs/design/spade.md §2). The head is Spade, the
 * main bot, with Search (which takes the head's place and finds conversations by their words),
 * Plugins & marketplace, and + (New bot, New group, Import bot). Then one row per bot or group on
 * every machine this window reaches: what needs the person, what works, what failed and what
 * they haven't seen, then the rest by latest activity. The foot is the person and the gear.
 * While Spade runs but waits on the person (a keychain prompt), what to look for, under the head.
 * The panel sees every machine, so it keeps Spade, the main bot, on one (`useOneSpade`).
 */
export function SpadeSidebar() {
  const status = useSpadeStatus();
  const [enabled] = useSpadeEnabled();
  const line = spadeStateLine(status, enabled);
  const setup = spadeSetupSentence(status);
  const roster = useSpadeRoster(line.ready);
  useOneSpade(roster.hosting);
  useTellZone(useMemo(() => roster.hosts.map((host) => host.machine.client), [roster.hosts]));
  const { groups } = useSpadeGroups(roster);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  // New bot and New group are conversations of their own (docs/design/spade.md §5).
  const newBot = () => void navigate({ to: "/spade/new" });
  const open = useParams({
    strict: false,
    select: (params) => params.agentId ?? params.groupId,
  });
  const missing = useGoalMissing(roster.bots);
  const all = spadeFlatEntries(roster.bots, groups, missing);
  const nested = spadeListEntries(roster.bots, groups, open, missing);
  const searched = query.trim() !== "";
  // Searching looks through everything, pinned too; otherwise the strip holds what's pinned.
  const split = searched
    ? { pinned: [], rest: searchSpadeList(all, query) }
    : splitPinned(nested, all);
  const rest = split.rest;
  // The main bot is the head, not a row or a pin: it only turns up among search results.
  const main = all.find((entry): entry is MainEntry => entry.kind === "bot" && isMain(entry));
  const entries = searched ? rest : rest.filter((entry) => !isMain(entry));
  const pinned = split.pinned.filter((entry) => !isMain(entry));
  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };
  return (
    <>
      <nav aria-label="Bots" className="flex min-h-0 flex-1 flex-col">
        <SpadeListHead
          main={main}
          idleDot={enabled === false ? "off" : status?.state === "failed" ? "failed" : undefined}
          current={main !== undefined && open === main.bot.id}
          searching={searching}
          query={query}
          onQuery={setQuery}
          onSearch={() => setSearching(true)}
          onCloseSearch={closeSearch}
          hosts={roster.hosts}
          onNewBot={newBot}
          onNewGroup={() => void navigate({ to: "/spade/groups/new" })}
        />
        {setup && line.ready && <SpadeStateStrip line={{ ...line, sentence: setup }} />}
        {pinned.length > 0 && <SpadePinStrip entries={pinned} bots={roster.bots} open={open} />}
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {/* The last list stays while Spade restarts or a read fails; it reads again on its own. */}
          {!roster.bots.length && !line.ready ? (
            // Spade off or not answering: one quiet sentence in the middle; Turn on is in the
            // conversation column, where Spade's chat would be.
            <p className="px-4 pt-[30%] text-center text-ui text-muted-foreground">
              {line.sentence}
            </p>
          ) : !roster.bots.length && roster.error ? (
            <div className="px-2.5 pt-3">
              <Problem text="Couldn't read Spade's bots." onRetry={roster.refetch} />
            </div>
          ) : !roster.bots.length && roster.loading ? (
            <ListSkeletonRows />
          ) : query.trim() && entries.length === 0 ? (
            <p className="px-2.5 pt-3 text-ui text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 pt-8 text-center">
              <p className="text-ui text-muted-foreground">Your bots show here.</p>
              {roster.hosts.length > 0 && (
                <Button
                  variant="secondary"
                  className="h-(--spade-pill-button) rounded-full px-4"
                  onClick={newBot}
                >
                  <Icon icon={PlusIcon} size={16} />
                  New bot
                </Button>
              )}
            </div>
          ) : (
            <ul className="flex flex-col">
              {entries.map((entry) =>
                entry.kind === "bot" ? (
                  <li
                    key={`${entry.bot.machine.key}/${entry.bot.id}`}
                    className={entry.depth ? "pl-6" : undefined}
                  >
                    <SpadeRowMenu entry={entry}>
                      <BotListRow
                        bot={entry.bot}
                        state={entry.row.state}
                        line={entry.row.line}
                        current={open === entry.bot.id}
                      />
                    </SpadeRowMenu>
                  </li>
                ) : (
                  <li key={`group:${entry.group.machine.key}/${entry.group.id}`}>
                    <SpadeRowMenu entry={entry}>
                      <GroupListRow
                        group={entry.group}
                        bots={roster.bots}
                        state={entry.row.state}
                        line={entry.row.line}
                        current={open === entry.group.id}
                      />
                    </SpadeRowMenu>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
        <SpadeListFoot main={main?.bot} />
      </nav>
    </>
  );
}
