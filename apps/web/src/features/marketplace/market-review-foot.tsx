import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { failureSentence, MarketFailure } from "./market-model.ts";
import { useFreshSignIn } from "./market-sign-in.ts";

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
}

export function reviewFailure(error: unknown): ReviewFailure {
  return {
    sentence: failureSentence(error, "install"),
    reauth: error instanceof MarketFailure && error.code === "reauth",
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
          <SignInAgain onSignedIn={props.onSignedIn} />
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

function SignInAgain(props: { onSignedIn(): void }) {
  const signIn = useFreshSignIn();
  const again = async () => {
    if (await signIn.start()) props.onSignedIn();
  };
  return (
    <span className="mk-grow" role="status">
      {signIn.signing
        ? "Finishing sign-in in your browser."
        : (signIn.problem ?? "Installing needs a recent sign-in to your ace account.")}{" "}
      {signIn.signing ? null : signIn.available ? (
        <button type="button" className="mk-text-button" onClick={() => void again()}>
          Sign in again
        </button>
      ) : (
        <Link className="mk-text-button" to="/settings/profile">
          Sign in
        </Link>
      )}
    </span>
  );
}
