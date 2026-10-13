import { Link } from "@tanstack/react-router";
import { childAskingLabel } from "@ace/ui-core";
import { Suspense, type ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { InteractionCard } from "../interactions/interaction-card.tsx";
import type { DescendantRequest } from "./descendant-request.ts";

/** The strip page a child's request takes: its interaction id, or its thread's when unloaded. */
export function descendantKey(request: DescendantRequest): string {
  return request.interactionId ?? `thread:${request.threadId}`;
}

/**
 * A delegated child's request in its parent's strip, labelled with the child's name and
 * answered right here: the answer resolves the child's own request. A request the strip can't
 * offer (not loaded, or with nothing to choose) reads "‹child› needs you · Open" and opens the
 * child. Messages the person queued in the parent wait for the child to finish (the queue rule
 * from #643: work still running in the tree holds person input), and the card says so.
 */
export function DescendantCard(props: {
  request: DescendantRequest;
  queued: number;
  aside: ReactNode;
  onControlsChange(): void;
}) {
  const { request } = props;
  return (
    <>
      {request.interactionId ? (
        <Suspense fallback={null}>
          <InteractionCard
            threadId={request.threadId}
            interactionId={request.interactionId}
            asker={request.name}
            frame="attached"
            aside={props.aside}
            onControlsChange={props.onControlsChange}
          />
        </Suspense>
      ) : (
        <p className="flex min-h-9 items-center gap-[7px] px-4 pt-2 text-ui">
          <Dot tone="needs-you" />
          <span className="min-w-0 truncate">{childAskingLabel(request.name)}</span>
          <Link
            to="/t/$threadId"
            params={{ threadId: request.threadId }}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Open
          </Link>
          <span className="ml-auto flex items-center gap-3">{props.aside}</span>
        </p>
      )}
      {props.queued > 0 && (
        <p className="px-4 pb-2.5 text-xs text-subtle-foreground">
          {props.queued === 1
            ? "Your queued message sends"
            : `Your ${props.queued} queued messages send`}{" "}
          once {request.name} is done.
        </p>
      )}
    </>
  );
}
