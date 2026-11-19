import type { SpadeStep } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * A reply's steps (docs/design/spade.md §3), as one quiet line under its words ("Ran 3 commands,
 * changed a file") that opens to each step: what it did and touched, where it ran and how it
 * ended. A step the person must see stands under the line unopened, in full ink: one the
 * network policy blocked, the review refused or the person declined, one that deletes or can't
 * be undone, and one that acted outside the bot's box. Words only: no icons, badges or tints.
 */
export function SpadeStepsLine(props: { summary: string; steps: readonly SpadeStep[] }) {
  const [open, setOpen] = useState(false);
  const notable = props.steps.filter((step) => step.notable);
  // Opening shows something the line doesn't already: a step folded away.
  const folds = props.steps.some((step) => !step.notable);
  return (
    <div className="ml-1.5 flex min-w-0 max-w-[64ch] flex-col">
      {folds ? (
        <Disclosure
          summary={<span className="min-w-0 truncate">{props.summary}</span>}
          summaryClassName="h-7 rounded-full px-2 text-ui"
          className="min-w-0 max-w-full"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          {open && <Steps label="Steps" steps={props.steps} />}
        </Disclosure>
      ) : (
        <p className="flex h-7 min-w-0 items-center px-2 text-ui text-muted-foreground">
          <span className="truncate">{props.summary}</span>
        </p>
      )}
      {!open && notable.length > 0 && <Steps label="Steps to look at" steps={notable} />}
    </div>
  );
}

function Steps(props: { label: string; steps: readonly SpadeStep[] }) {
  return (
    <ol
      aria-label={props.label}
      className="mt-0.5 mb-1 ml-3.5 flex flex-col gap-1.5 border-l border-border pl-3.5"
    >
      {props.steps.map((step) => (
        <Step key={step.key} step={step} />
      ))}
    </ol>
  );
}

/** One step: its words and what it touched, then where and how it went, then what was blocked. */
function Step(props: { step: SpadeStep }) {
  const { step } = props;
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
    </li>
  );
}
