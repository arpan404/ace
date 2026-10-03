import { CheckIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Fragment } from "react";
import { Icon } from "@/components/icon.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { deckSteps, type DeckRun } from "@ace/ui-core";

/** Goal → Plan approved → Dealing · n of m merged → Merge. */
export function DeckStepper(props: { run: DeckRun }) {
  const list = deckSteps(props.run);
  const paused = props.run.phase === "paused" || props.run.phase === "cancelled";
  return (
    <ol aria-label="Deck progress" className="mt-3.5 flex flex-wrap items-center gap-2.5 text-sm">
      {list.map((step, index) => (
        <Fragment key={step.label}>
          {index > 0 && <li aria-hidden className="h-px w-7 bg-border" />}
          <li
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5",
              step.state === "done" && "text-muted-foreground",
              step.state === "current" && "font-medium text-foreground",
              step.state === "todo" && "text-subtle-foreground",
            )}
          >
            {step.state === "done" && <Icon icon={CheckIcon} size={14} />}
            {step.state === "current" &&
              (paused ? (
                <span aria-hidden className="size-1.5 rounded-full bg-subtle-foreground" />
              ) : (
                <Spinner className="text-status-working" />
              ))}
            {step.state === "todo" && <Icon icon={LockSimpleIcon} size={14} />}
            {step.label}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
