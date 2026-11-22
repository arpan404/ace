import type { SpadeStartedWorker } from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { Suspense, useEffect, useRef } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { DeferredInteractionCard, useOpenRequest } from "@/features/thread/index.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { OnBotMachine, type WorkerHandlers } from "./spade-delegation.tsx";
import { useSpadeWorkers, type SpadeWorkerEntry } from "./use-spade-workers.ts";

/*
 * What the bot's ace agents wait on the person for, at the end of its chat: each one's open plan,
 * question or approval as ace's own card, answered here for the agent (on its machine). Every
 * other waiting worker (a bot it made, a request not loaded or not answerable here) is answered
 * from its row in the subagent card, whose Review opens it, so "Needs you" always leads somewhere
 * (AGENTS.md priority 1). `data-request="workers"` is where a notice or the bot list's "Needs you"
 * lands; with no card here, that is the first waiting row's Review.
 */

export function SpadeWaitingWorkers(props: {
  workers: readonly SpadeStartedWorker[];
  handlers: WorkerHandlers;
  /** Opened to answer it: brought into view and to the keyboard once it shows. */
  reveal: boolean;
}) {
  if (!props.workers.length) return null;
  return <OnBotMachine>{(reachable) => <Waiting {...props} reachable={reachable} />}</OnBotMachine>;
}

function Waiting(props: {
  workers: readonly SpadeStartedWorker[];
  handlers: WorkerHandlers;
  reveal: boolean;
  reachable: boolean;
}) {
  const { entries, fresh } = useSpadeWorkers(props.handlers.bot, props.workers, 0, props.reachable);
  // Only what is current says a worker waits on the person.
  const waiting = fresh ? entries.filter((entry) => entry.state === "human") : [];
  const asks = props.reachable ? waiting.filter((entry) => entry.kind === "ace") : [];
  const region = useRef<HTMLDivElement>(null);
  const shown = waiting.length > 0;
  const { reveal } = props;
  useEffect(() => {
    if (!shown || !reveal) return;
    const frame = requestAnimationFrame(() => {
      const card = region.current?.querySelector("[data-worker-request] > *");
      const target = card
        ? region.current
        : document.querySelector<HTMLElement>("[data-worker-review]");
      target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, reveal]);
  if (!asks.length) return null;
  return (
    <div
      ref={region}
      role="region"
      aria-label="Needs you"
      tabIndex={-1}
      data-request="workers"
      // Focused as the chat opens on it, for the keyboard: a target, not a control, so no ring.
      className="mt-(--chat-turn-gap) flex w-full max-w-150 min-w-0 flex-col gap-3 outline-none empty:hidden"
    >
      {asks.map((entry) => (
        <AceAsk key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

/** An ace agent's open request as ace's own card, answered here for the agent. */
function AceAsk(props: { entry: SpadeWorkerEntry }) {
  const { entry } = props;
  const request = useOpenRequest(entry.id);
  if (!request) return null;
  return (
    // A target "Needs you" brings into view and to the keyboard, not a control: no ring around it
    // (the card's own buttons keep theirs).
    <div data-worker-request={entry.id} tabIndex={-1} className="outline-none">
      <Suspense fallback={null}>
        <DeferredInteractionCard.Component
          threadId={entry.id}
          interactionId={request.id}
          asker={entry.title}
          frame="card"
          aside={
            <Link
              {...threadOn(entry.machineHost, entry.id)}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Open
            </Link>
          }
        />
      </Suspense>
    </div>
  );
}
