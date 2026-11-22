import { CheckIcon, CopyIcon } from "@ace/icons";
import type { ReactNode } from "react";
import { Button } from "./ui/button.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { useToast } from "./ui/toast.tsx";
import { useCopy } from "./use-copy.ts";
import { cn } from "@/lib/cn.ts";

/**
 * The one "ace couldn't start" body, exactly as the boot screen drew it on main: the screen's
 * ace mark and word above it, the title, one grey sentence, the raw error in a soft code box
 * with Copy in its corner, then a full-width Reload. Both the boot error boundary and the
 * startup screen draw this; the boot screen's mark comes from its connect card, the startup
 * screen's from the splash mark over it.
 */
export function StartFailure(props: {
  description: ReactNode;
  /** The raw error, shown at once; never a daemon token. */
  details?: string | undefined;
  /** The screen's own actions (Reload, Connection settings…); a plain Reload without any. */
  actions?: ReactNode;
  /** Labels the screen that draws it (`ConnectCard`'s `labelledBy`). */
  titleId?: string | undefined;
  role?: "alert";
  className?: string | undefined;
}) {
  const toast = useToast();
  const message = props.details;
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the message and copy it yourself." }),
  );
  return (
    <div role={props.role} className={cn("w-full", props.className, "mt-0 mb-0")}>
      <h1 id={props.titleId} className="mt-4 text-xl font-semibold tracking-title">
        ace couldn't start
      </h1>
      <p className="mt-1.5 text-ui leading-normal text-muted-foreground">{props.description}</p>
      {message && (
        <div className="relative mt-4 mb-6 rounded-md bg-secondary">
          <pre className="max-h-48 overflow-auto py-2.5 pr-9 pl-3 font-mono text-sm break-words whitespace-pre-wrap text-foreground">
            {message}
          </pre>
          <IconButton
            icon={copied ? CheckIcon : CopyIcon}
            label={copied ? "Copied" : "Copy error"}
            size="sm"
            onClick={() => copy(message)}
            className="absolute top-1.5 right-1.5"
          />
        </div>
      )}
      <div className={cn("flex gap-2 [&>*]:flex-1", !message && "mt-6")}>
        {props.actions ?? (
          <Button variant="primary" className="h-9 flex-1" onClick={() => location.reload()}>
            Reload
          </Button>
        )}
      </div>
    </div>
  );
}
