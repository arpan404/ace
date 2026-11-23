import { spadeAgentTasks, spadeLanesMoved, type SpadeView } from "@ace/ui-core/spade-chat";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient } from "../spade-machine.tsx";
import type { RosterBot } from "../use-spade-roster.ts";
import { retryLane, useLanesChanged, useSpadeLanes } from "./lanes-api.ts";
import type { LanesHere } from "./lanes-context.ts";

/**
 * A bot's tasks as its main conversation shows them (ADR 0217 §7): read while the roster counts
 * any or main's chat has a task's line, again as those lines arrive, and what opens a task or
 * tries it again.
 */
export function useMainLanes(bot: RosterBot, view: SpadeView, open: (lane: string) => void) {
  const client = useSpadeClient();
  const toast = useToast();
  const changed = useLanesChanged(bot.conversation);
  const moved = useMemo(
    () => spadeLanesMoved(view.entries, view.approvals.length),
    [view.entries, view.approvals.length],
  );
  const counted = spadeAgentTasks(bot.raw);
  const listed = useSpadeLanes(bot.conversation, moved + counted, moved > 0 || counted > 0);
  const titles = view.laneTitles;
  return useMemo<LanesHere>(() => {
    // A title the title role gave since the list was read wins (ADR 0217 §2a).
    const lanes = listed.map((lane) => {
      const title = titles.get(lane.task);
      return title && title !== lane.title ? { ...lane, title } : lane;
    });
    return {
      lanes,
      avatar: bot.avatar,
      titleOf: (lane, said) =>
        titles.get(lane) ?? lanes.find((each) => each.task === lane)?.title ?? said,
      open,
      retry: (lane, reply) =>
        retryLane(client, lane, reply).then(
          () => {
            changed();
            return true;
          },
          (error: unknown) => {
            toast.error({ title: "Couldn't try the task again", description: message(error) });
            return false;
          },
        ),
    };
    // `open` follows the route; the lanes, their titles and the bot's face are what this
    // changes with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed, titles, bot.avatar, client]);
}
