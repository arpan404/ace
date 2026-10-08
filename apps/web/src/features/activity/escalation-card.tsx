import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { eventKey } from "./activity-state.tsx";
import { ButtonKey, CardActions, CardError, CardFrame, useCardFocused } from "./card-frame.tsx";
import { useFeedSource, type FeedEvent } from "./feed-source.ts";
import { useProjectName } from "@/lib/projects.ts";
import { InteractionCard } from "./interaction-card.tsx";
import { useDeckChoice } from "./escalations.ts";

/**
 * A deck's decision: its plan, a merge, or an escalation (a lane that keeps failing review, a
 * budget or a deadline). Approve takes A, and O opens the deck. An agent's own question in a
 * deck is answered in place, like any request.
 */
export function EscalationCard(props: { event: FeedEvent }) {
  const projectName = useProjectName();
  const { interaction } = props.event;
  if (interaction)
    return (
      <InteractionCard
        threadId={interaction.threadId}
        interactionId={interaction.interactionId}
        cardKey={eventKey(props.event.id)}
        context={`${projectName(props.event.project)} · ${props.event.context}`}
      />
    );
  return <DecisionCard event={props.event} />;
}

function DecisionCard(props: { event: FeedEvent }) {
  const { event } = props;
  const key = eventKey(event.id);
  const focused = useCardFocused(key);
  const source = useFeedSource();
  const toast = useToast();
  const projectName = useProjectName();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [rejecting, setRejecting] = useState(false);
  // The Deck's own words for this gate: what approving and rejecting do (`gateDecision`).
  const choice = useDeckChoice(event);
  const actions = event.actions ?? [];
  const primary = actions.find((action) => action.primary);
  const take = (actionId: string) => {
    setSending(true);
    setFailure(undefined);
    source.resolve(event, actionId).then(
      () => {
        const done = actionId === "reject" ? choice?.reject.toast : choice?.approve?.toast;
        if (done) toast.add({ title: done });
      },
      (error: unknown) => {
        setSending(false);
        setFailure(
          error instanceof Error && error.message !== "not_found"
            ? error.message
            : "The offset didn't accept that. Open the offset to see why.",
        );
      },
    );
  };
  const live = focused && !sending;
  useHotkey("a", () => primary && take(primary.id), { enabled: live && !!primary });
  const openDeck = () =>
    event.runId
      ? void navigate({ to: "/offsets/$runId", params: { runId: event.runId } })
      : void navigate({ to: "/offsets" });
  useHotkey("o", openDeck, { enabled: focused });
  return (
    <CardFrame
      cardKey={key}
      title={event.title}
      context={`${projectName(event.project)} · ${event.context}`}
      at={event.at}
    >
      {event.body && (
        <p className="text-[13.5px] leading-normal text-muted-foreground">{event.body}</p>
      )}
      {choice && !choice.approve && (
        <p className="text-sm text-muted-foreground">
          Answering this needs a new value. Open the offset to set it.
        </p>
      )}
      <CardActions>
        {/* A gate that needs a value is answered in the deck: opening it is the main action. */}
        <Button variant={primary ? "ghost" : "primary"} onClick={openDeck}>
          Open offset
          <ButtonKey primary={!primary}>O</ButtonKey>
        </Button>
        {actions.map((action) => (
          <Button
            key={action.id}
            variant={action.primary ? "primary" : "secondary"}
            disabled={sending}
            // Rejecting is confirmed first, saying what it does to the deck.
            onClick={() => (action.id === "reject" ? setRejecting(true) : take(action.id))}
          >
            {action.label}
            {action.primary && <ButtonKey primary>A</ButtonKey>}
          </Button>
        ))}
      </CardActions>
      <CardError message={failure} />
      {choice && (
        <Dialog open={rejecting} onOpenChange={setRejecting}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{choice.reject.title}</DialogTitle>
              <DialogDescription>{choice.reject.body}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
                {choice.reject.stopsDeck ? "Keep it running" : "Cancel"}
              </Button>
              <Button
                type="button"
                variant={choice.reject.stopsDeck ? "danger" : "primary"}
                disabled={sending}
                onClick={() => {
                  setRejecting(false);
                  take("reject");
                }}
              >
                {choice.reject.confirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </CardFrame>
  );
}
