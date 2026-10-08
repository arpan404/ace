import { CheckIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Fragment } from "react";
import { Icon } from "@/components/icon.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { DeckStep } from "@ace/ui-core";

/**
 * Goal → Plan approved → Dealing · n of m merged → Merge. Pure: pass `deckStepper(run)`. On a
 * phone the steps stack and the connectors go, so none dangles at the end of a wrapped line.
 */
export function DeckStepper(props: { steps: readonly DeckStep[]; paused: boolean }) {
  const { steps: list, paused } = props;
  return (
    <ol
      aria-label="Offset progress"
      className="mt-3.5 flex flex-col items-start gap-1.5 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5"
    >
      {list.map((step, index) => (
        <Fragment key={step.label}>
          {index > 0 && <li aria-hidden className="hidden h-px w-7 bg-border sm:block" />}
          <li
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5",
              step.state === "done" && "text-muted-foreground",
              step.state === "current" && "font-medium text-foreground",
              step.state === "todo" && "text-muted-foreground",
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
