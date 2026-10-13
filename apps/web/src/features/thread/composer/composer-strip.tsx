import { useClient, useConnectionState, useInteractions } from "@ace/client-react";
import type { QueuedMessage, ThreadStatus } from "@ace/protocol";
import { Suspense, useState } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useClaimConnectionNotice } from "@/features/shell/index.ts";
import { useShownPlans } from "@/lib/use-plans.ts";
import { useHeldQueue } from "./queue-notice.tsx";
import { QueueStrip } from "./queue-strip.tsx";
import { queuedCount } from "./queued.tsx";
import { useQueuedPending } from "./queued-pending.ts";
import { RequestStack } from "./request-stack.tsx";
import { ConnectionStrip, PlanStrip, StripIndicators, type StripCounts } from "./strip-items.tsx";
import { pickStrip, stripSlot, type StripFacts } from "./strip-slot.ts";
import { StripSurface } from "./strip-surface.tsx";
import { useQueue } from "./use-queue.ts";

const noRequests: readonly string[] = [];

/**
 * The one strip above the thread's composer (`stripSlot` decides what it shows): the agent's
 * open requests, trouble with the connection, the queue, or the main agent's plan, with the
 * others as indicators inside it. Loads after the thread has painted, unless the thread opens
 * on a request.
 */
export function ComposerStrip(props: {
  threadId: string;
  status: ThreadStatus | undefined;
  /** A request to open on (a notification's target). */
  requestTarget?: string | undefined;
  /** Put the caret back in the message. */
  onLeave(): void;
  onChooseModel(): void;
}) {
  const client = useClient();
  const daemon = useDaemonConnection();
  const requests = useInteractions(props.threadId) ?? noRequests;
  const connection = useConnectionState();
  const queue = useQueue(props.threadId);
  const pending = useQueuedPending(props.threadId, queue.page, queue.retained);
  const held = useHeldQueue(props.threadId, props.status, queue);
  const plan = useShownPlans(props.threadId)[0]?.progress;
  const queued = queuedCount(queue, pending);
  const offline = connection === "offline";
  // Reconnecting and offline are said here, so the header stays quiet; anything else (a
  // fatal error) is the header's.
  useClaimConnectionNotice(offline || connection === "reconnecting");
  // An open edit keeps the queue in the slot even once its message leaves the queue, so the
  // editor can say so and keep the person's wording.
  const [editing, setEditing] = useState<QueuedMessage>();
  const facts: StripFacts = {
    requests,
    target: props.requestTarget,
    connection: offline || connection === "reconnecting",
    queue: queued > 0 || queue.failed || !!held || !!editing,
    plan: !!plan,
  };
  const [pick, setPick] = useState<ReturnType<typeof pickStrip>>();
  const slot = stripSlot(facts, pick);
  if (!slot.shown) return null;
  const counts: StripCounts = { requests: requests.length, offline, queued, plan };
  const indicators = (
    <StripIndicators
      kinds={slot.others}
      counts={counts}
      onPick={(kind) => setPick(pickStrip(kind, facts))}
    />
  );
  return (
    <StripSurface slot={slot.shown}>
      {slot.shown === "request" ? (
        <Suspense fallback={null}>
          <RequestStack
            threadId={props.threadId}
            ids={requests}
            target={props.requestTarget}
            onLeave={props.onLeave}
            indicators={indicators}
          />
        </Suspense>
      ) : slot.shown === "connection" ? (
        <ConnectionStrip
          offline={offline}
          onRetry={() => (offline ? daemon.retry() : client.reconnectNow())}
          indicators={indicators}
        />
      ) : slot.shown === "queue" ? (
        <QueueStrip
          threadId={props.threadId}
          queue={queue}
          pending={pending}
          held={held}
          editing={editing}
          onEdit={setEditing}
          indicators={indicators}
          onChooseModel={props.onChooseModel}
        />
      ) : plan ? (
        <PlanStrip progress={plan} indicators={indicators} />
      ) : null}
    </StripSurface>
  );
}
