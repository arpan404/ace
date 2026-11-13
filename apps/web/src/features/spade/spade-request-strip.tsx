import { spadeRequestWords, type SpadeApproval, type SpadeAvatar } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { StripSurface } from "@/features/thread/index.ts";
import { callDetails } from "./spade-chat.tsx";
import { SpadeFace } from "./spade-face.tsx";

/** The exact command a shell call would run, which "Always allow" covers. */
function shellCommand(name: string, args: unknown): string | undefined {
  if (name !== "shell" || typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/**
 * A bot's oldest open request in the strip above the composer, as ace shows an agent's: its
 * face, who wants to do what to whom, the first line of what it would send, then Review (the
 * whole call, and "Always allow this command" for a command), the answer that lets it go, and
 * the one that doesn't. What the bot drafted stays in the conversation above.
 */
export function SpadeRequestStrip(props: {
  bot: { name: string; avatar: SpadeAvatar };
  approval: SpadeApproval;
  /** More waiting after this one. */
  more: number;
  onAnswer(callId: string, allowed: boolean, always: boolean): Promise<boolean>;
}) {
  const { approval } = props;
  const words = spadeRequestWords(approval.name, approval.arguments, props.bot.name);
  const command = shellCommand(approval.name, approval.arguments);
  const details = callDetails(approval.arguments);
  const [open, setOpen] = useState(false);
  const [answering, setAnswering] = useState<"allow" | "deny" | "always">();
  const answer = (choice: "allow" | "deny" | "always") => {
    setAnswering(choice);
    void props.onAnswer(approval.callId, choice !== "deny", choice === "always").then((sent) => {
      if (!sent) setAnswering(undefined);
    });
  };
  return (
    <StripSurface slot={`request:${approval.callId}`} variant={open ? "open" : "closed"}>
      <div role="group" aria-label={words.title} className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <SpadeFace avatar={props.bot.avatar} size={24} state="needs-you" />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate text-ui text-foreground">
              {words.title}
              {props.more > 0 && (
                <span className="text-muted-foreground">{` · ${props.more} more`}</span>
              )}
            </p>
            {words.detail && (
              <p className="truncate text-xs text-muted-foreground">{words.detail}</p>
            )}
            {approval.reason && (
              <p className="truncate text-xs text-muted-foreground">{`Asked because ${approval.reason}`}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {details && (
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={open}
                onClick={() => setOpen((shown) => !shown)}
              >
                Review
              </Button>
            )}
            <Button
              size="xs"
              variant="secondary"
              disabled={answering !== undefined}
              onClick={() => answer("allow")}
            >
              {answering === "allow" ? `${words.allow}…` : words.allow}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={answering !== undefined}
              onClick={() => answer("deny")}
            >
              {words.deny}
            </Button>
          </div>
        </div>
        {open && details && (
          <div className="flex flex-col gap-1.5">
            <pre
              aria-label="Details"
              className="no-scrollbar max-h-48 overflow-auto rounded-md bg-code px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--border)]"
            >
              {details}
            </pre>
            {command !== undefined && (
              <Button
                size="xs"
                variant="ghost"
                className="self-start"
                disabled={answering !== undefined}
                onClick={() => answer("always")}
              >
                Always allow this command
              </Button>
            )}
          </div>
        )}
      </div>
    </StripSurface>
  );
}
