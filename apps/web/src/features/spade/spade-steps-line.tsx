import type { SpadeStep, SpadeTurnUndo } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeUndoDialog, type UndoAsk } from "./spade-undo.tsx";

/** The quiet words that undo, beside the line or under a step. */
const undoWords =
  "h-7 rounded-full px-2 text-ui text-muted-foreground hover:bg-hover hover:text-foreground";

/** A reply's finished steps and its undo actions (docs/design/spade.md §3). */
export function SpadeStepsLine(props: {
  summary: string;
  steps: readonly SpadeStep[];
  undo?: SpadeTurnUndo | undefined;
  /** The bot whose files undo puts back; without it, no undo is offered. */
  bot?: { id: string; name: string } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<UndoAsk>();
  const stays = props.undo?.stays ?? [];
  const turn = props.bot ? props.undo : undefined;
  const undoStep = props.bot
    ? (step: SpadeStep) => {
        if (step.undoFrom !== undefined)
          setAsked({ from: step.undoFrom, what: "this change", stays });
      }
    : undefined;
  return (
    <div className="ml-1.5 flex min-w-0 max-w-[64ch] flex-col">
      <div className="flex min-w-0 items-center gap-1">
        <Disclosure
          summary={<span className="min-w-0 truncate">{props.summary}</span>}
          summaryClassName="h-7 rounded-full px-2 text-ui"
          className="min-w-0 max-w-full"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          {open && <Steps steps={props.steps} onUndo={undoStep} />}
        </Disclosure>
        {turn && !open && (
          <Button
            variant="ghost"
            className={cn(undoWords, "shrink-0 self-start")}
            onClick={() => setAsked({ from: turn.from, what: "this reply's changes", stays })}
          >
            Undo these changes
          </Button>
        )}
      </div>
      {props.bot && (
        <SpadeUndoDialog bot={props.bot} ask={asked} onDone={() => setAsked(undefined)} />
      )}
    </div>
  );
}

function Steps(props: {
  steps: readonly SpadeStep[];
  onUndo: ((step: SpadeStep) => void) | undefined;
}) {
  return (
    <ol
      aria-label="Steps"
      className="mt-0.5 mb-1 ml-3.5 flex flex-col gap-1.5 border-l border-border pl-3.5"
    >
      {props.steps.map((step) => (
        <Step key={step.key} step={step} onUndo={props.onUndo} />
      ))}
    </ol>
  );
}

function Step(props: { step: SpadeStep; onUndo: ((step: SpadeStep) => void) | undefined }) {
  const { step, onUndo } = props;
  const facts = [...step.meta, ...step.blocked];
  return (
    <li className="min-w-0 text-ui">
      <span className="text-muted-foreground">
        {step.line}
        {step.detail && (
          <>
            {" "}
            <code className="font-mono text-xs leading-5 break-all text-muted-foreground">
              {step.detail}
            </code>
          </>
        )}
        {facts.length > 0 && (
          <span className="text-subtle-foreground">{` · ${facts.join(" · ")}`}</span>
        )}
      </span>
      {onUndo && step.undoFrom !== undefined && (
        <Button
          variant="ghost"
          className={cn(undoWords, "ml-1 text-xs")}
          onClick={() => onUndo(step)}
        >
          Undo these changes
        </Button>
      )}
    </li>
  );
}
