import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { Navigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readingColumn } from "@/features/thread/index.ts";
import { SpadeApprovalStrip } from "./spade-approval-strip.tsx";
import { SpadeComposer } from "./spade-composer.tsx";
import { SpadeStateStrip } from "./spade-state.tsx";
import { SpadeTranscript } from "./spade-transcript.tsx";
import { useSpadeConversation } from "./use-spade-conversation.ts";
import { useSpadeAgents } from "./use-spade-agents.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

/** Spade's state line while it isn't running, for the composer's blocked reason. */
function useSpadeLine() {
  const [enabled] = useSpadeEnabled();
  return spadeStateLine(useSpadeStatus(), enabled);
}

function pinToEnd(element: HTMLElement | null, atEnd: boolean) {
  if (element && atEnd) element.scrollTop = element.scrollHeight;
}

/**
 * A scroller that stays at its end while the person is there, as the conversation grows: on
 * every render and whenever the content's height changes after it (markdown paints late).
 */
function Scroller(props: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => pinToEnd(scroller.current, atEnd.current));
  useLayoutEffect(() => {
    const inner = content.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => pinToEnd(scroller.current, atEnd.current));
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
    >
      <div ref={content} className={`${readingColumn} pt-6 pb-16`}>
        {props.children}
      </div>
    </div>
  );
}

/** `/spade`: Spade's own conversation, once the roster says where it is. */
export function SpadeNewScreen() {
  const line = useSpadeLine();
  const main = useSpadeAgents(line.ready).data?.find((agent) => agent.kind === "main");
  if (main)
    return (
      <Navigate
        to="/spade/$conversationId"
        params={{ conversationId: main.conversation }}
        replace
      />
    );
  return (
    <Screen title="Spade" namedByPanel>
      <div className={`${readingColumn} pt-6`}>
        <SpadeStateStrip line={line} className="flex items-center gap-2 px-1 text-ui" />
      </div>
    </Screen>
  );
}

/** `/spade/<id>`: one conversation, live. */
export function SpadeConversationScreen(props: { conversationId: string }) {
  return <Conversation key={props.conversationId} conversationId={props.conversationId} />;
}

function Conversation(props: { conversationId: string }) {
  const conversation = useSpadeConversation(props.conversationId);
  const { view, problem } = conversation;
  const line = useSpadeLine();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  // Stopping lasts until nothing is open: the reply and its background jobs.
  if (stopping && !view.busy) setStopping(false);
  const stop = () => {
    setStopping(true);
    conversation.stop().catch((error: unknown) => {
      setStopping(false);
      toast.error({ title: "Couldn't stop Spade", description: message(error) });
    });
  };
  const approval = view.approvals[0];
  return (
    <Screen title={view.title || "New conversation"}>
      <div className="flex h-full min-h-0 flex-col">
        <Scroller>
          {problem ? (
            <div role="alert" className="flex items-center gap-2 text-ui text-muted-foreground">
              <span className="min-w-0 flex-1">{problem}</span>
              <Button size="xs" variant="ghost" onClick={conversation.retry}>
                Try again
              </Button>
            </div>
          ) : !view.loaded ? (
            line.ready ? (
              <LoadingRegion label="Conversation" className="flex flex-col gap-3">
                <Skeleton className="ml-auto h-9 w-48 rounded-lg" />
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3.5 w-1/2" />
              </LoadingRegion>
            ) : (
              <SpadeStateStrip line={line} className="flex items-center gap-2 text-ui" />
            )
          ) : (
            <SpadeTranscript
              conversation={props.conversationId}
              view={view}
              onStop={stop}
              stopping={stopping}
            />
          )}
        </Scroller>
        <SpadeComposer
          draftKey={`spade:${props.conversationId}`}
          answering={view.answering}
          blocked={line.ready ? undefined : line.sentence}
          placeholder={view.answering ? "Steer Spade's reply" : "Message Spade"}
          send={conversation.send}
          attached={
            approval && (
              <SpadeApprovalStrip
                key={approval.callId}
                approval={approval}
                more={view.approvals.length - 1}
                onAnswer={(allowed, always) =>
                  conversation.answer(approval.callId, allowed, always).then(
                    () => true,
                    (error: unknown) => {
                      toast.error({
                        title: "Couldn't answer Spade",
                        description: message(error),
                      });
                      return false;
                    },
                  )
                }
              />
            )
          }
        />
      </div>
    </Screen>
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : "Try again.");
