import { useState } from "react";
import { AceSignInReturnStatus } from "@ace/protocol/ace-account";
import { Button } from "@/components/ui/button.tsx";
import { useDismissBootSplash } from "@/lib/boot-splash.ts";
import { ConnectCard } from "./connect-card.tsx";

const copy: Record<AceSignInReturnStatus, { title: string; body: string }> = {
  "signed-in": {
    title: "You're signed in to ace",
    body: "Go back to the ace tab where you started. You can close this one.",
  },
  cancelled: {
    title: "Sign-in was cancelled",
    body: "You can keep using ace without an account. Close this tab to go back.",
  },
  failed: { title: "Couldn't sign in", body: "Go back to ace and try again." },
  expired: {
    title: "This sign-in expired",
    body: "It took too long or was already used. Go back to ace and start again.",
  },
};

/** How a sign-in's `?status=` reads; anything unrecognised reads as a failure. */
export function signInLandingStatus(search: string): AceSignInReturnStatus {
  const status = AceSignInReturnStatus.safeParse(new URLSearchParams(search).get("status"));
  return status.success ? status.data : "failed";
}

/**
 * Where the browser lands after ace sign-in started from the web app (ADR 0100). The tab that
 * started it gets the session from its own claim, so this tab only says how it ended and offers
 * to close itself; it never connects to a daemon.
 */
export function SignInLanding(props: { status: AceSignInReturnStatus; close: () => void }) {
  useDismissBootSplash();
  const [kept, setKept] = useState(false);
  const { title, body } = copy[props.status];
  return (
    <ConnectCard labelledBy="sign-in-landing-title">
      <h1 id="sign-in-landing-title" className="mt-4 text-xl font-semibold tracking-title">
        {title}
      </h1>
      <p className="mt-1.5 text-ui leading-normal text-muted-foreground">{body}</p>
      <Button
        className="mt-6"
        onClick={() => {
          props.close();
          // A browser only lets a page close a tab a script opened; otherwise it stays.
          setKept(true);
        }}
      >
        Close tab
      </Button>
      {kept && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Your browser kept this tab open. You can close it yourself.
        </p>
      )}
    </ConnectCard>
  );
}
