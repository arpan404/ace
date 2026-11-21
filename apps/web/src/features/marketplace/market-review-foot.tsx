import { isStandingRefusal } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { useMachineAccountAccess } from "@/features/settings/index.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import type { ReactNode } from "react";
import { failureSentence, MarketFailure } from "./market-model.ts";

/*
 * A review's sticky foot: what stops Install, or what went wrong, in one sentence beside the
 * actions. A refusal that wants a recent sign-in is never a dead end: it says so and offers to
 * sign in again, then Install runs again by itself.
 */

/** Why the last Install didn't go through. */
export interface ReviewFailure {
  sentence: string;
  /** The market wants a sign-in from the last ten minutes (ADR 0174 §2). */
  reauth: boolean;
  standing: boolean;
}

export function reviewFailure(error: unknown): ReviewFailure {
  return {
    sentence: failureSentence(error, "install"),
    reauth: error instanceof MarketFailure && error.code === "reauth",
    standing: error instanceof MarketFailure && isStandingRefusal(error.detail),
  };
}

export function ReviewFoot(props: {
  /** What stops Install before it is pressed, such as a required app left off. */
  stuck: string | undefined;
  failure: ReviewFailure | undefined;
  /** Runs Install again once a fresh sign-in landed. */
  onSignedIn(): void;
  children: ReactNode;
}) {
  const { failure } = props;
  const problem = failure && !failure.reauth ? failure.sentence : props.stuck;
  return (
    <div className="mk-foot">
      <div className="mk-foot-inner">
        {failure?.reauth ? (
          <SignInAgain standing={failure.standing} onSignedIn={props.onSignedIn} />
        ) : (
          <span
            className="mk-grow"
            role={problem ? "alert" : undefined}
            data-tone={problem ? "failed" : undefined}
          >
            {problem ?? ""}
          </span>
        )}
        {props.children}
      </div>
    </div>
  );
}

function SignInAgain(props: { standing: boolean; onSignedIn(): void }) {
  const access = useMachineAccountAccess(usePrimaryMachine());
  return (
    <ConfirmPerson
      className="mk-grow"
      freshSignIn={!props.standing}
      freshSignInSentence="Installing needs a recent sign-in to your ace account."
      beforeProof={async (origin, token) => {
        const status = await access?.status().catch(() => undefined);
        if (access && !status?.signedIn) await access.signIn(origin, token);
      }}
      onConfirmed={props.onSignedIn}
    />
  );
}
