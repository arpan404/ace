import { useEffect } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ConnectCard } from "./connect-card.tsx";

/**
 * A link asked to connect this window to a daemon it can't vouch for: one on another machine,
 * or one that would replace the token remembered here. Nothing is saved until the person agrees.
 * For another machine the safe answer comes first and has focus; Esc gives it too.
 * Rendered by the connection screen, which dismisses the boot splash.
 */
export function HandoffScreen(props: {
  url: string;
  reason: "elsewhere" | "replaces-remembered";
  /** A connection is stored, which declining keeps. */
  keepsCurrent?: boolean;
  onConnect(): void;
  onDecline(): void;
}) {
  const elsewhere = props.reason === "elsewhere";
  const { onDecline } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onDecline();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onDecline]);
  const decline = (
    <Button
      variant={elsewhere ? "primary" : "secondary"}
      className="h-9 flex-1"
      onClick={props.onDecline}
      autoFocus={elsewhere}
    >
      Don't connect
    </Button>
  );
  const connect = (
    <Button
      variant={elsewhere ? "secondary" : "primary"}
      className="h-9 flex-1"
      onClick={props.onConnect}
    >
      Connect
    </Button>
  );
  return (
    <ConnectCard labelledBy="handoff-title">
      <h1 id="handoff-title" className="mt-4 text-xl font-semibold tracking-title">
        Connect to this daemon?
      </h1>
      <p className="mt-1.5 text-ui leading-normal text-muted-foreground">
        A link asked ace to connect to:
      </p>
      <p className="mt-2 rounded-md bg-secondary px-3 py-2 font-mono text-sm break-all text-foreground">
        {hostOf(props.url)}
        <span className="sr-only"> (</span>
        <span className="block text-xs text-muted-foreground">{props.url}</span>
        <span className="sr-only">)</span>
      </p>
      <p className="mt-3 mb-6 text-ui leading-normal text-muted-foreground">
        {elsewhere
          ? "It isn't on this computer. Everything you type in ace would go to it, so only connect if you started it yourself."
          : "Connecting replaces the token remembered on this device."}
      </p>
      <div className="flex gap-2">
        {elsewhere ? (
          <>
            <div className="flex flex-1 flex-col gap-1">
              {decline}
              {props.keepsCurrent && (
                <span className="text-center text-xs text-muted-foreground">
                  Keeps your current connection
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-col">{connect}</div>
          </>
        ) : (
          <>
            {connect}
            {decline}
          </>
        )}
      </div>
    </ConnectCard>
  );
}

/** `host:port` of a daemon address, the part a person can check. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
