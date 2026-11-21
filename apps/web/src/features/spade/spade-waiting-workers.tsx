import { spadeAskingWords, type SpadeStartedWorker } from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { Suspense, useEffect, useRef } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { DeferredInteractionCard, useOpenRequest } from "@/features/thread/index.ts";
import { threadOn } from "@/lib/machine-routes.ts";
import { OnBotMachine, type WorkerHandlers } from "./spade-delegation.tsx";
import { useSpadeWorkers, type SpadeWorkerEntry } from "./use-spade-workers.ts";

/*
 * What the bot's tree waits on the person for, at the end of its chat: each worker it started
 * that waits on them, with what it asks right here. An ace agent's plan, question or approval is
 * ace's own card, and answering it resolves the agent's request (on its machine); a bot it made
 * that waits opens its chat. So "Needs you" always leads somewhere (AGENTS.md priority 1).
 * `data-request="workers"` is where a notice or the bot list's "Needs you" lands.
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
  const region = useRef<HTMLDivElement>(null);
  const shown = waiting.length > 0;
  const { reveal } = props;
  useEffect(() => {
    if (!shown || !reveal) return;
    const frame = requestAnimationFrame(() => {
      region.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      region.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, reveal]);
  if (!shown) return null;
  return (
    <div
      ref={region}
      role="region"
      aria-label="Waiting for you"
      tabIndex={-1}
      data-request="workers"
      className="mt-(--chat-turn-gap) flex w-full max-w-150 min-w-0 flex-col gap-3 focus-ring"
    >
      {waiting.map((entry) =>
        entry.kind === "ace" && props.reachable ? (
          <AceAsk key={entry.id} entry={entry} />
        ) : (
          <Asks key={entry.id} entry={entry} handlers={props.handlers} />
        ),
      )}
    </div>
  );
}

/** An ace agent's open request as ace's own card, answered here for the agent. */
function AceAsk(props: { entry: SpadeWorkerEntry }) {
  const { entry } = props;
  const request = useOpenRequest(entry.id);
  return (
    <div data-worker-request={entry.id} tabIndex={-1} className="focus-ring">
      {request ? (
        <Suspense fallback={<Asks entry={entry} handlers={undefined} />}>
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
      ) : (
        <Asks entry={entry} handlers={undefined} />
      )}
    </div>
  );
}

/**
 * A waiting worker the chat can't answer for in place (a bot, a request with nothing to choose,
 * not loaded yet): who waits and on what, and Open, which goes where it is answered.
 */
function Asks(props: { entry: SpadeWorkerEntry; handlers: WorkerHandlers | undefined }) {
  const { entry, handlers } = props;
  const words = entry.kind === "ace" ? spadeAskingWords(entry.asking) : "Needs you";
  return (
    <p
      data-worker-request={entry.kind === "bot" ? entry.id : undefined}
      className="flex min-h-9 min-w-0 items-center gap-[7px] text-ui"
    >
      <StatusGlyph state="needs-you" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{entry.title}</span>
        {entry.machine && <span className="text-subtle-foreground"> on {entry.machine}</span>}
        <span className="text-muted-foreground"> · {words}</span>
      </span>
      {entry.kind === "ace" ? (
        <Link
          {...threadOn(entry.machineHost, entry.id)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Open
        </Link>
      ) : (
        handlers?.onOpenBot && (
          <Button variant="ghost" size="sm" onClick={() => handlers.onOpenBot?.(entry.id)}>
            Open
          </Button>
        )
      )}
    </p>
  );
}
