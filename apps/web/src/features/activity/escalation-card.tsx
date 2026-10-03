import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { eventKey } from "./activity-state.tsx";
import { ButtonKey, CardActions, CardError, CardFrame, useCardFocused } from "./card-frame.tsx";
import { useFeedSource, type FeedEvent } from "./feed-source.ts";
import { useProjectName } from "@/lib/projects.ts";

/**
 * A Deck escalation: a lane that keeps failing review, a budget or a deadline. Approve takes
 * A, and O opens the deck.
 */
export function EscalationCard(props: { event: FeedEvent }) {
  const { event } = props;
  const key = eventKey(event.id);
  const focused = useCardFocused(key);
  const source = useFeedSource();
  const toast = useToast();
  const projectName = useProjectName();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const actions = event.actions ?? [];
  const primary = actions.find((action) => action.primary);
  const take = (actionId: string, label: string) => {
    setSending(true);
    setFailure(undefined);
    source.resolve(event, actionId).then(
      () => toast.add({ title: `${label} · the deck carries on` }),
      (error: unknown) => {
        setSending(false);
        setFailure(
          error instanceof Error && error.message !== "not_found"
            ? error.message
            : "The deck didn't accept that. Open the deck to see why.",
        );
      },
    );
  };
  const live = focused && !sending;
  useHotkey("a", () => primary && take(primary.id, primary.label), { enabled: live && !!primary });
  const openDeck = () =>
    event.runId
      ? void navigate({ to: "/deck/$runId", params: { runId: event.runId } })
      : void navigate({ to: "/deck" });
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
      <CardActions>
        <Button variant="ghost" onClick={openDeck}>
          Open deck
          <ButtonKey>O</ButtonKey>
        </Button>
        {actions.map((action) => (
          <Button
            key={action.id}
            variant={action.primary ? "primary" : "secondary"}

            disabled={sending}
            onClick={() => take(action.id, action.label)}
          >
            {action.label}
            {action.primary && <ButtonKey primary>A</ButtonKey>}
          </Button>
        ))}
      </CardActions>
      <CardError message={failure} />
    </CardFrame>
  );
}
