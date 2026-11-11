import type { SpadeView } from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { StripSurface } from "@/features/thread/index.ts";

type Approval = SpadeView["approvals"][number];

function argumentsText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)
    return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * The oldest approval Spade waits on, in the composer's strip: one sentence ("Spade wants to send
 * an email."), then Allow, Allow always and Decline; Details shows the call's arguments. More
 * waiting: "1 more" after the sentence. Answering is one request; the strip moves on once Spade
 * stores the answer.
 */
export function SpadeApprovalStrip(props: {
  approval: Approval;
  more: number;
  /** Resolves whether Spade took the answer. */
  onAnswer(allowed: boolean, always: boolean): Promise<boolean>;
}) {
  const { approval } = props;
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);
  const details = useId();
  const args = argumentsText(approval.arguments);
  const answer = (allowed: boolean, always: boolean) => {
    setSending(true);
    // A taken answer keeps the buttons off until Spade stores it and the strip moves on.
    void props.onAnswer(allowed, always).then((taken) => {
      if (!taken) setSending(false);
    });
  };
  return (
    <StripSurface slot="request" variant={approval.callId}>
      <section aria-label="Spade asks" className="flex flex-col gap-2 pb-1">
        <p className="text-ui text-foreground">
          {approval.sentence}
          {props.more > 0 && (
            <span className="text-muted-foreground">{` · ${props.more} more`}</span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={sending}
            onClick={() => answer(true, false)}
          >
            Allow
          </Button>
          <Button size="sm" disabled={sending} onClick={() => answer(true, true)}>
            Allow always
          </Button>
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => answer(false, false)}>
            Decline
          </Button>
          {args && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              aria-expanded={open}
              aria-controls={details}
              onClick={() => setOpen(!open)}
            >
              Details
            </Button>
          )}
        </div>
        {open && args && (
          <pre
            id={details}
            className="max-h-40 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-xs leading-[1.5] whitespace-pre-wrap break-words text-foreground"
          >
            {args}
          </pre>
        )}
      </section>
    </StripSurface>
  );
}
