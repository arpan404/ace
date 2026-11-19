import type { Thread, ThreadStatus } from "@ace/protocol";
import { guestSession, type GuestSession as Guest } from "@ace/ui-core";
import { Suspense, type ReactNode } from "react";
import { FloatingContents } from "@/components/ui/floating-material.tsx";
import { cn } from "@/lib/cn.ts";
import { ComposerDock } from "../composer/composer-dock.tsx";
import { composerSurface } from "../composer/composer-styles.ts";
import { DeferredComposerStrip } from "../composer/deferred-cards.ts";
import { useThreadStop } from "../composer/use-thread-stop.ts";
import { barAction } from "../subagent/subagent-status-bar.tsx";

const nothing = () => {};

/**
 * The bottom of a thread: its composer (`children`), unless it is a guest session, where agents
 * on another machine use this one's tools (ADR 0105). Nobody here talks to them, so one line
 * says whose work it is, with Stop while it runs. Requests waiting for the person still show
 * above it, so they can be answered on this machine too.
 */
export function GuestBottom(props: {
  thread: Thread;
  requestTarget?: string | undefined;
  children: ReactNode;
}) {
  const guest = guestSession(props.thread);
  if (!guest) return props.children;
  return (
    <GuestSession
      threadId={props.thread.id}
      status={props.thread.status}
      guest={guest}
      requestTarget={props.requestTarget}
    />
  );
}

function GuestSession(props: {
  threadId: string;
  status: ThreadStatus | undefined;
  guest: Guest;
  requestTarget: string | undefined;
}) {
  const { working } = props.guest;
  const { stop, stopping } = useThreadStop(props.threadId, working);
  return (
    <ComposerDock>
      <FloatingContents glass>
        <Suspense fallback={null}>
          <DeferredComposerStrip.Component
            threadId={props.threadId}
            status={props.status}
            stopping={stopping}
            requestTarget={props.requestTarget}
            onLeave={nothing}
            onChooseModel={nothing}
          />
        </Suspense>
        <div
          role="group"
          aria-label="Guest session"
          className={cn(
            composerSurface,
            "relative z-10 flex h-12 min-w-0 items-center gap-2 rounded-xl pr-2 pl-4 text-ui",
          )}
        >
          <p className="min-w-0 flex-1 truncate text-muted-foreground">{props.guest.line}</p>
          {working && (
            <button type="button" onClick={stop} disabled={stopping} className={barAction}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
      </FloatingContents>
    </ComposerDock>
  );
}
