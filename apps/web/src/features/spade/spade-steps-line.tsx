import type { SpadeStep, SpadeTurnUndo } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeUndoDialog, type UndoAsk } from "./spade-undo.tsx";

/** The quiet words that undo, beside the line or under a step. */
const undoWords =
  "h-7 rounded-full px-2 text-ui text-muted-foreground hover:bg-hover hover:text-foreground";

/**
 * A reply's steps (docs/design/spade.md §3), as one quiet line under its words ("Ran 3 commands,
 * changed a file") that opens to each step: what it did and touched, where it ran and how it
 * ended. A step the person must see stands under the line unopened, in full ink: one the
 * network policy blocked, the review refused or the person declined, one that deletes or can't
 * be undone, and one that acted outside the bot's box; when every step is such a one, they stand
 * alone, with no line counting them. Words only: no icons, badges or tints.
 *
 * Undo (ADR 0167): the line offers "Undo these changes" for the whole turn when any step changed
 * the bot's files, and each such step offers it from itself; a step that can't be undone (a send,
 * a push, a payment, an app it changed) says so in its own line.
 */
export function SpadeStepsLine(props: {
  summary: string;
  steps: readonly SpadeStep[];
  undo?: SpadeTurnUndo | undefined;
  /** The bot whose files undo puts back; without it, no undo is offered. */
  bot?: { id: string; name: string } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<UndoAsk>();
  const notable = props.steps.filter((step) => step.notable);
  // Opening shows something the line doesn't already: a step folded away.
  const folds = props.steps.some((step) => !step.notable);
  // Whatever undo reverts, the turn's outward steps stay as they are.
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
        {/* With every step standing on its own, a line counting them would only repeat them. */}
        {folds && (
          <Disclosure
            summary={<span className="min-w-0 truncate">{props.summary}</span>}
            summaryClassName="h-7 rounded-full px-2 text-ui"
            className="min-w-0 max-w-full"
            onToggle={(event) => setOpen(event.currentTarget.open)}
          >
            {open && <Steps label="Steps" steps={props.steps} onUndo={undoStep} />}
          </Disclosure>
        )}
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
      {!open && notable.length > 0 && (
        <Steps label="Steps to look at" steps={notable} onUndo={undoStep} />
      )}
      {props.bot && (
        <SpadeUndoDialog bot={props.bot} ask={asked} onDone={() => setAsked(undefined)} />
      )}
    </div>
  );
}

function Steps(props: {
  label: string;
  steps: readonly SpadeStep[];
  onUndo: ((step: SpadeStep) => void) | undefined;
}) {
  return (
    <ol
      aria-label={props.label}
      className="mt-0.5 mb-1 ml-3.5 flex flex-col gap-1.5 border-l border-border pl-3.5"
    >
      {props.steps.map((step) => (
        <Step key={step.key} step={step} onUndo={props.onUndo} />
      ))}
    </ol>
  );
}

/**
 * One step: its words and what it touched, then where and how it went, then what was blocked,
 * then whether it can be undone.
 */
function Step(props: { step: SpadeStep; onUndo: ((step: SpadeStep) => void) | undefined }) {
  const { step, onUndo } = props;
  return (
    <li className="flex min-w-0 flex-col text-ui">
      <p className={cn("min-w-0", step.notable ? "text-foreground" : "text-muted-foreground")}>
        {step.line}
        {step.detail && (
          <>
            {" "}
            <code className="font-mono text-xs leading-5 break-all text-muted-foreground">
              {step.detail}
            </code>
          </>
        )}
      </p>
      {step.meta.length > 0 && (
        <p className="text-xs leading-5 text-subtle-foreground">{step.meta.join(" · ")}</p>
      )}
      {step.blocked.map((blocked) => (
        <p key={blocked} className="text-xs leading-5 text-foreground">
          {blocked}
        </p>
      ))}
      {step.cantUndo && <p className="text-xs leading-5 text-foreground">{step.cantUndo}</p>}
      {onUndo && step.undoFrom !== undefined && (
        <Button
          variant="ghost"
          className={cn(undoWords, "-ml-2 w-fit text-xs")}
          onClick={() => onUndo(step)}
        >
          Undo these changes
        </Button>
      )}
    </li>
  );
}
