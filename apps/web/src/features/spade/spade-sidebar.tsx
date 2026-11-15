import { spadeSetupSentence, spadeStateLine } from "@ace/ui-core/spade-chat";
import { PlusIcon } from "@phosphor-icons/react";
import { useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { NewBotDialog } from "./spade-bot-dialog.tsx";
import { NewGroupDialog } from "./spade-group-dialog.tsx";
import { SpadeListSearch, SpadeListTop } from "./spade-list-head.tsx";
import { BotListRow, GroupListRow, ListSkeletonRows } from "./spade-list-parts.tsx";
import { searchSpadeList, spadeListEntries } from "./spade-list-rows.ts";
import { Problem } from "./spade-screen-parts.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useOneSpade, useSpadeRoster } from "./use-spade-roster.ts";
import { useSpadeStatus } from "./use-spade-status.ts";
import { useTellZone } from "./use-spade-zone.ts";
import { useSpadeGroups } from "./use-spade-groups.ts";

/**
 * Spade's panel, a messenger's list (ADR 0127, docs/design/spade.md §2). Three buttons on top:
 * Search, which opens in place over the rows and finds conversations by their words, Plugins &
 * marketplace, and + (New bot, New group, Import bot). Then one row per bot or group on every
 * machine this window reaches: Spade, the main bot, first as an ordinary row, then what needs
 * the person, what works, what failed and what they haven't seen, then the rest by latest
 * activity. While Spade runs but waits on the person (a keychain prompt), what to look for, under
 * the top. The panel sees every machine, so it keeps Spade, the main
 * bot, on one (`useOneSpade`).
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
  const [creating, setCreating] = useState<"bot" | "group">();
  const open = useParams({
    strict: false,
    select: (params) => params.agentId ?? params.groupId,
  });
  const all = spadeListEntries(roster.bots, groups);
  const entries = searchSpadeList(all, query);
  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };
  return (
    <>
      <nav aria-label="Bots" className="flex min-h-0 flex-1 flex-col">
        <SpadeListTop
          searching={searching}
          onSearch={() => (searching ? closeSearch() : setSearching(true))}
          hosts={roster.hosts}
          onNewBot={() => setCreating("bot")}
          onNewGroup={() => setCreating("group")}
        />
        {setup && line.ready && <SpadeStateStrip line={{ ...line, sentence: setup }} />}
        {searching && <SpadeListSearch query={query} onQuery={setQuery} onClose={closeSearch} />}
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {/* The last list stays while Spade restarts or a read fails; it reads again on its own. */}
          {!roster.bots.length && !line.ready ? null : !roster.bots.length && roster.error ? (
            <div className="px-2.5 pt-3">
              <Problem text="Couldn't read Spade's bots." onRetry={roster.refetch} />
            </div>
          ) : !roster.bots.length && roster.loading ? (
            <ListSkeletonRows />
          ) : query.trim() && entries.length === 0 ? (
            <p className="px-2.5 pt-3 text-ui text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          ) : all.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 pt-8 text-center">
              <p className="text-ui text-muted-foreground">Your bots show here.</p>
              {roster.hosts.length > 0 && (
                <Button
                  variant="secondary"
                  className="h-(--spade-pill-button) rounded-full px-4"
                  onClick={() => setCreating("bot")}
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
                  <li key={`${entry.bot.machine.key}/${entry.bot.id}`}>
                    <BotListRow
                      bot={entry.bot}
                      state={entry.row.state}
                      line={entry.row.line}
                      current={open === entry.bot.id}
                    />
                  </li>
                ) : (
                  <li key={`group:${entry.group.machine.key}/${entry.group.id}`}>
                    <GroupListRow
                      group={entry.group}
                      bots={roster.bots}
                      state={entry.row.state}
                      line={entry.row.line}
                      current={open === entry.group.id}
                    />
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
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
    </>
  );
}
