import type { InteractionRequest } from "@ace/protocol";
import { browserHelpDetail } from "@ace/ui-core";
import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useRevealBrowserTab } from "@/features/panels/index.ts";
import type { Answer } from "./answer.ts";

type Request = Extract<InteractionRequest, { kind: "browser_help" }>;

/**
 * An agent waits on the person in a browser tab (sign in, a check, a code, a dialog): Open tab
 * shows that tab in the side panel, Done tells the agent to carry on, Skip that it won't happen.
 */
export function BrowserHelp(props: {
  threadId: string;
  request: Request;
  disabled: boolean;
  /** Opened from its notification: show the tab straight away. */
  targeted?: boolean | undefined;
  onAnswer: Answer;
}) {
  const reveal = useRevealBrowserTab(props.threadId);
  const [gone, setGone] = useState(false);
  const show = () => void reveal(props.request.tabId).then((shown) => setGone(!shown));
  const showOnNotice = useEffectEvent(show);
  useEffect(() => {
    if (props.targeted) showOnNotice();
  }, [props.targeted]);
  const detail = browserHelpDetail(props.request);
  return (
    <div className="flex flex-col gap-2.5">
      {detail && <p className="text-ui text-muted-foreground">{detail}</p>}
      {gone && (
        <p role="alert" className="text-xs text-status-failed">
          Couldn't show the tab. It may have closed.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={props.disabled}
          onClick={() => props.onAnswer({ kind: "browser_help", outcome: "done" })}
        >
          Done
        </Button>
        <Button size="sm" variant="secondary" onClick={show}>
          Open tab
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={props.disabled}
          onClick={() => props.onAnswer({ kind: "browser_help", outcome: "skipped" })}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}
