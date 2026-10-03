import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { inkLabel } from "@/components/ui/ink-label.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { eventKey } from "./activity-state.tsx";
import { ButtonKey, CardActions, CardError, CardFrame, useCardFocused } from "./card-frame.tsx";
import { useFeedSource, type FeedEvent } from "./feed-source.ts";

/**
 * A Deck escalation: a lane that keeps failing review. The deck proposes what to do; the
 * primary proposal takes A, every proposal its number, and O opens the deck.
 */
export function EscalationCard(props: { event: FeedEvent }) {
  const { event } = props;
  const key = eventKey(event.id);
  const focused = useCardFocused(key);
  const source = useFeedSource();
  const toast = useToast();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const actions = event.actions ?? [];
  const primary = actions.find((action) => action.primary);
  const take = (actionId: string, label: string) => {
    setSending(true);
    setFailure(undefined);
    source.resolve(event.id, actionId).then(
      () => toast.add({ title: `${label} · the deck replans` }),
      () => {
        setSending(false);
        setFailure("The deck didn't accept that. Open the deck to see why.");
      },
    );
  };
  const live = focused && !sending;
  useHotkey("a", () => primary && take(primary.id, primary.label), { enabled: live && !!primary });
  useHotkey("o", () => void navigate({ to: "/deck" }), { enabled: focused });
  return (
    <CardFrame
      cardKey={key}
      title={event.title}
      context={`${event.project} · ${event.context}`}
      at={event.at}
    >
      {event.body && (
        <p className="text-[13.5px] leading-normal text-muted-foreground">{event.body}</p>
      )}
      <CardActions>
        <Link to="/deck" className={buttonVariants({ variant: "ghost" })}>
          Open deck
          <ButtonKey>O</ButtonKey>
        </Link>
        {actions.map((action) => (
          <Button
            key={action.id}
            variant={action.primary ? "primary" : "secondary"}
            className={action.primary ? inkLabel : undefined}
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
