import { spadeMoney, type SpadeBriefWaiting, type SpadeDigest } from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { answerFromBrief } from "./spade-reach-api.ts";
import { chatBubble, framed } from "./spade-bubble-style.ts";
import { BubbleFrame } from "./spade-chat-parts.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault } from "./spade-settings-rows.tsx";

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The morning brief (ADR 0194) as a message in Spade's main chat: what finished, each line
 * opening the bot's conversation it happened in; what waits on the person, answered here in one
 * tap where it can be; today's routines; and spend since the last brief. Words, no chrome.
 */
export function SpadeBriefBubble(props: { digest: SpadeDigest; when: string | undefined }) {
  const brief = props.digest.brief;
  if (!brief)
    return (
      <BubbleFrame side="bot" when={props.when} copy={props.digest.text} speak={props.digest.text}>
        <p className={cn(chatBubble, framed, "whitespace-pre-wrap")}>{props.digest.text}</p>
      </BubbleFrame>
    );
  const spent = brief.spend.map((bot) => `${bot.name} ${spadeMoney(bot.micros)}`).join(", ");
  return (
    <BubbleFrame side="bot" when={props.when} copy={props.digest.text} speak={props.digest.text}>
      <div
        role="article"
        aria-label="Morning brief"
        className={cn(chatBubble, framed, "flex flex-col gap-2")}
      >
        <p className="font-semibold text-foreground">Finished</p>
        {brief.finished.length === 0 ? (
          <p className="text-muted-foreground">Nothing finished.</p>
        ) : (
          <ul aria-label="Finished" className="flex flex-col gap-1">
            {brief.finished.map((line) => (
              <li key={`${line.conversation}:${line.seq}`}>
                <Link
                  to="/spade/$agentId"
                  params={{ agentId: line.agent }}
                  className="text-link hover:underline"
                >
                  {line.name}
                </Link>
                {`: ${line.text}`}
              </li>
            ))}
            {brief.moreFinished > 0 && <li>{`and ${brief.moreFinished} more`}</li>}
          </ul>
        )}
        {brief.waiting.length > 0 && (
          <>
            <p className="font-semibold text-foreground">Waiting on you</p>
            <ul aria-label="Waiting on you" className="flex flex-col gap-2">
              {brief.waiting.map((waiting) => (
                <WaitingLine key={`${waiting.conversation}:${waiting.callId}`} waiting={waiting} />
              ))}
            </ul>
          </>
        )}
        {brief.away.length > 0 && (
          <>
            <p className="font-semibold text-foreground">While you were away</p>
            <ul className="flex flex-col gap-1">
              {brief.away.map((away) => (
                <li key={`${away.name}:${away.text}`}>{`${away.name}: ${away.text}`}</li>
              ))}
            </ul>
          </>
        )}
        {brief.today.length > 0 && (
          <>
            <p className="font-semibold text-foreground">Today</p>
            <ul aria-label="Today" className="flex flex-col gap-1">
              {brief.today.map((planned) => (
                <li key={`${planned.name}:${planned.routine}:${planned.at}`}>
                  {`${planned.name}: ${planned.routine} at ${timeOf(planned.at)}`}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="tabular-nums">
          {brief.spendMicros > 0
            ? `Spent ${spadeMoney(brief.spendMicros)}${spent ? ` (${spent})` : ""}.`
            : "Spent nothing."}
        </p>
      </div>
    </BubbleFrame>
  );
}

/** One open request with the answers a tap can give, else a way to it. */
function WaitingLine(props: { waiting: SpadeBriefWaiting }) {
  const { waiting } = props;
  const client = useSpadeClient();
  const [state, setState] = useState<{ sent?: string; busy?: boolean; refused?: string }>({});
  const answers: { label: string; answer: { allowed: boolean } | { value: string | boolean } }[] =
    waiting.answer === "approval"
      ? [
          { label: "Allow once", answer: { allowed: true } },
          { label: "Deny", answer: { allowed: false } },
        ]
      : waiting.answer === "confirm"
        ? [
            { label: "Yes", answer: { value: true } },
            { label: "No", answer: { value: false } },
          ]
        : waiting.answer === "choice"
          ? waiting.options.map((option) => ({ label: option, answer: { value: option } }))
          : [];
  const send = (label: string, answer: (typeof answers)[number]["answer"]) => {
    setState({ busy: true });
    void answerFromBrief(client, waiting, answer).then(
      () => setState({ sent: label }),
      (error: unknown) => setState({ refused: fault(error) }),
    );
  };
  return (
    <li className="flex flex-col gap-1">
      <span>
        <Link
          to="/spade/$agentId"
          params={{ agentId: waiting.agent }}
          search={{ request: waiting.callId }}
          className="text-link hover:underline"
        >
          {waiting.name}
        </Link>
        {`: ${waiting.what}`}
      </span>
      {state.sent ? (
        <span className="text-ui text-muted-foreground">{`Answered: ${state.sent}`}</span>
      ) : (
        answers.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {answers.map((choice) => (
              <Button
                key={choice.label}
                size="sm"
                variant="ghost"
                disabled={state.busy}
                onClick={() => send(choice.label, choice.answer)}
              >
                {choice.label}
              </Button>
            ))}
          </span>
        )
      )}
      {state.refused && <span className="text-ui text-status-failed">{state.refused}</span>}
    </li>
  );
}
