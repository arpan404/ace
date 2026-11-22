import { useState, type ReactNode } from "react";
import { Button } from "./ui/button.tsx";
import { useToast } from "./ui/toast.tsx";
import { useCopy } from "./use-copy.ts";
import { cn } from "@/lib/cn.ts";

/**
 * The one "ace couldn't start" card: the screen's ace mark sits above it (the boot screen's
 * wordmark, the startup screen's mark), then the title, one plain sentence, the raw error behind
 * Details, and the actions in one row. A boot failure is not a choice between two designs any
 * more: both the boot error boundary and the startup screen draw this.
 */
export function StartFailure(props: {
  description: ReactNode;
  /** The raw error, for support; shown only when someone opens Details. */
  details?: string | undefined;
  /** The screen's own actions (Reload, Connection settings…); a plain Reload without any. */
  actions?: ReactNode;
  /** Labels the screen that draws it (`ConnectCard`'s `labelledBy`). */
  titleId?: string | undefined;
  role?: "alert";
  className?: string | undefined;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const text = props.details ?? (typeof props.description === "string" ? props.description : "");
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the message and copy it yourself." }),
  );
  return (
    <div
      role={props.role}
      className={cn(
        "flex w-full flex-col rounded-lg bg-surface-1 p-6 text-left",
        props.className,
        "max-w-[440px]",
      )}
    >
      <h1 id={props.titleId} className="text-xl font-semibold tracking-title text-foreground">
        ace couldn't start
      </h1>
      <p className="mt-2 text-ui leading-normal text-muted-foreground">{props.description}</p>
      {props.details && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
            className="mt-3 w-fit rounded-sm text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground"
          >
            {open ? "Hide details" : "Details"}
          </button>
          {open && (
            <pre className="mt-2 max-h-[200px] overflow-auto rounded-md bg-code p-3 font-mono text-sm leading-normal break-words whitespace-pre-wrap text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
              {props.details}
            </pre>
          )}
        </>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {props.actions ?? (
          <Button variant="primary" onClick={() => location.reload()}>
            Reload
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={!text}
          onClick={() => copy(text)}
          aria-label="Copy details"
        >
          {copied ? "Copied" : "Copy details"}
        </Button>
      </div>
    </div>
  );
}
