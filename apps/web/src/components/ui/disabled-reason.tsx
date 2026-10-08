import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

/** Keep a disabled control's reason reachable by pointer and keyboard. */
export function DisabledReason(props: { reason: string | undefined; children: ReactNode }) {
  return (
    <Tooltip disabled={!props.reason}>
      <TooltipTrigger
        render={
          <span
            tabIndex={props.reason ? 0 : undefined}
            className="inline-flex rounded-md focus-ring *:flex-1"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent>{props.reason}</TooltipContent>
    </Tooltip>
  );
}
