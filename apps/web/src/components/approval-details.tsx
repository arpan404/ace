import type { ApprovalChoice, ApprovalCopy } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * What an ace tool's approval asks for (computer use, page scripts, downloads, uploads): the
 * agent's reason, the risk in one sentence, the exact facts and code it acts on. The thread's
 * card and Activity's draw the same words (`approvalCopy` in @ace/ui-core).
 */
export function ApprovalDetails(props: { copy: ApprovalCopy; className?: string }) {
  const { copy } = props;
  return (
    <div className={cn("flex flex-col gap-2", props.className)}>
      {copy.reason && (
        <p className="text-ui text-foreground">
          <span className="text-muted-foreground">Agent's reason: </span>
          {copy.reason}
        </p>
      )}
      {copy.risk && (
        <p className="text-ui text-muted-foreground">
          <b
            className={cn(
              "mr-[7px] font-medium",
              copy.risk.level === "high" ? "text-status-failed" : "text-status-needs-you",
            )}
          >
            {copy.risk.level === "high" ? "High risk." : "Check first."}
          </b>
          {copy.risk.text}
        </p>
      )}
      {copy.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {copy.facts.map((fact, index) => (
            <Fact key={`${fact.label}:${index}`} label={fact.label}>
              <span className={cn("break-all", fact.code && "font-mono text-xs")}>
                {fact.value}
              </span>
            </Fact>
          ))}
        </dl>
      )}
      {copy.code && (
        <pre
          aria-label="Script"
          className="max-h-48 overflow-auto rounded-md bg-code px-3 py-[9px] font-mono text-xs leading-[1.5] whitespace-pre-wrap"
        >
          {copy.code}
        </pre>
      )}
    </div>
  );
}

function Fact(props: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-subtle-foreground">{props.label}</dt>
      <dd className="min-w-0 text-foreground">{props.children}</dd>
    </>
  );
}

/** The request's options as buttons, in order; a default-to-no request fills none of them. */
export function ApprovalButtons(props: {
  choices: readonly ApprovalChoice[];
  disabled?: boolean;
  onChoose(choice: ApprovalChoice): void;
  /** Number keys 1–9 answer, in the thread; Activity binds its own keys. */
  numbered?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.choices.map((choice, index) => (
        <Button
          key={choice.option.id}
          size="sm"
          variant={
            choice.emphasis === "primary"
              ? "primary"
              : choice.emphasis === "secondary"
                ? "secondary"
                : "ghost"
          }
          disabled={props.disabled}
          aria-keyshortcuts={props.numbered && index < 9 ? String(index + 1) : undefined}
          onClick={() => props.onChoose(choice)}
        >
          {choice.label}
        </Button>
      ))}
    </div>
  );
}
