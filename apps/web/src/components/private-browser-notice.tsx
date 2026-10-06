import { LockSimpleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * The daemon's hold while a person keeps a thread's browser private: nothing to approve here.
 * The agent resumes only once the person hands the browser back from it (or closes it).
 */
export function PrivateBrowserNotice(props: { action?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-ui text-muted-foreground">
      <LockSimpleIcon aria-hidden size={15} className="mt-0.5 shrink-0 text-status-needs-you" />
      <p className="min-w-0 flex-1">
        You're holding this thread's browser privately, so its agents can't see the page and are
        waiting. Hand it back from the browser when you're done.
      </p>
      {props.action}
    </div>
  );
}
