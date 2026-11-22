import { CheckIcon, CopyIcon, WarningCircleIcon } from "@ace/icons";
import type { ReactNode } from "react";
import { IconButton } from "./ui/icon-button.tsx";
import { useToast } from "./ui/toast.tsx";
import { useCopy } from "./use-copy.ts";
import { cn } from "@/lib/cn.ts";

/**
 * The one "ace couldn't start" anatomy: the failed glyph, what happened, the actions, and the
 * raw error behind Details. The startup screen, the boot error boundary and the bare fallback
 * (which draws its own plain version) all say it this way.
 */
export function StartFailure(props: {
  description: ReactNode;
  /** The raw error, for support; shown only when someone opens Details. */
  details?: string | undefined;
  actions?: ReactNode;
  /** Labels the screen that draws it (`ConnectCard`'s `labelledBy`). */
  titleId?: string | undefined;
  role?: "alert";
  className?: string | undefined;
}) {
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the message and copy it yourself." }),
  );
  return (
    <div
      role={props.role}
      className={cn("flex max-w-[420px] flex-col items-center gap-2 text-center", props.className)}
    >
      <WarningCircleIcon aria-hidden size={20} weight="fill" className="text-status-failed" />
      <h1 id={props.titleId} className="text-ui font-medium text-foreground">
        ace couldn't start
      </h1>
      <p className="max-w-[44ch] text-sm leading-normal text-muted-foreground">
        {props.description}
      </p>
      {props.details && (
        <details className="mt-1 w-full text-left">
          <summary className="mx-auto w-fit cursor-default text-xs text-subtle-foreground focus-ring hover:text-foreground">
            Details
          </summary>
          <div className="relative mt-2 rounded-md bg-secondary">
            <pre className="max-h-48 overflow-auto py-2.5 pr-9 pl-3 font-mono text-sm break-words whitespace-pre-wrap text-foreground">
              {props.details}
            </pre>
            <IconButton
              icon={copied ? CheckIcon : CopyIcon}
              label={copied ? "Copied" : "Copy error"}
              size="sm"
              onClick={() => copy(props.details ?? "")}
              className="absolute top-1.5 right-1.5"
            />
          </div>
        </details>
      )}
      {props.actions && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">{props.actions}</div>
      )}
    </div>
  );
}
