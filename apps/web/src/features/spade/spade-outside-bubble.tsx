import type { SpadeBubble } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Kbd } from "@/components/ui/kbd.tsx";
import {
  CardBody,
  cardKeyHint,
  CardFooter,
  CardPrimary,
  CardWord,
  NeedsYouLine,
  RaisedCard,
} from "./spade-card.tsx";
import type { RequestAnswer } from "./spade-request-bubble.tsx";

type Outside = Extract<SpadeBubble, { kind: "plugin-outside" }>;

/**
 * A plugin's server or hook that the sandbox can't seal off, asking to run outside it (ADR 0167):
 * Spade's one sentence, what would run, then Always for this plugin version and Deny on the
 * left and Allow (this once) on the right. Until it is answered the plugin doesn't start. With
 * focus on it, Enter allows once and Escape denies. Once answered it leaves the chat.
 */
export function SpadeOutsideBubble(props: {
  item: Outside;
  onAnswer(id: string, answer: RequestAnswer): Promise<boolean>;
}) {
  const { item } = props;
  const [answering, setAnswering] = useState<RequestAnswer>();
  const answer = (choice: RequestAnswer) => {
    if (answering !== undefined) return;
    setAnswering(choice);
    void props.onAnswer(item.id, choice).then((sent) => {
      if (!sent) setAnswering(undefined);
    });
  };
  return (
    <RaisedCard
      asks="request"
      role="group"
      aria-label={item.line.replace(/[.?]$/, "")}
      // Focusable while open, so Enter and Escape answer it from the keyboard.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answer("deny");
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          answer("allow");
        }
      }}
    >
      <NeedsYouLine glyph="request">
        <p>{item.line}</p>
      </NeedsYouLine>
      <CardBody>
        <p className="text-ui leading-5 text-muted-foreground">
          {`${item.plugin} ${item.version}, ${item.what}`}
        </p>
      </CardBody>
      <CardFooter
        start={
          <>
            <CardWord disabled={answering !== undefined} onClick={() => answer("always")}>
              {answering === "always" ? "Allowing…" : "Always for this plugin version"}
            </CardWord>
            <CardWord disabled={answering !== undefined} onClick={() => answer("deny")}>
              {answering === "deny" ? "Denying…" : "Deny"}
            </CardWord>
          </>
        }
        end={
          <CardPrimary disabled={answering !== undefined} onClick={() => answer("allow")}>
            {answering === "allow" ? "Allowing…" : "Allow"}
            <Kbd
              aria-hidden
              keys="enter"
              resolve={false}
              variant="on-primary"
              className={cardKeyHint}
            />
          </CardPrimary>
        }
      />
    </RaisedCard>
  );
}
