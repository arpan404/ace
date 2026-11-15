import type { SpadeTaskLine, SpadeView } from "@ace/ui-core/spade-chat";

/**
 * The bot is at work, so Stop is offered: a reply, a tool or a background job runs, its task
 * carries on by itself, or a waiting task has a step Spade will start (Stop calls that step off).
 * Waiting on the person (a card or an approval, with nothing running beside it) is not work: the
 * composer then shows Send.
 */
export function spadeWorks(
  view: Pick<SpadeView, "busy" | "working">,
  task: SpadeTaskLine | undefined,
  continuing: boolean,
): boolean {
  const waitingOnPerson = view.working?.moving === false;
  return (
    (view.busy && !waitingOnPerson) ||
    task?.tone === "working" ||
    (task?.tone === "waiting" && continuing)
  );
}
