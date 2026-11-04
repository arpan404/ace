import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { MissingState } from "@/components/ui/missing-state.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";

/** The daemon has no such thread: deleted, or it belongs to another daemon. */
const missing = new Set(["not_found", "thread_not_found", "read_denied"]);
/** The connection failed, not the thread: the agents on the daemon carry on regardless. */
const transport = new Set(["offline", "timeout", "unavailable"]);

/** What a thread that couldn't be opened says, in words; with a way back home. */
export function threadLoadFailure(error: unknown): {
  title: string;
  description: string;
  code: string;
} {
  const code = daemonErrorCode(error);
  if (missing.has(code))
    return {
      title: "This thread doesn't exist",
      description: "It may have been deleted, or it belongs to another computer.",
      code,
    };
  const reason = describeDaemonError(code);
  return {
    title: "This thread couldn't be loaded",
    description: transport.has(code) ? `${reason} The agents keep working.` : reason,
    code,
  };
}

/** The thread screen when its thread couldn't be opened: why, and a new thread or Home. */
export function ThreadLoadError(props: { error: unknown }) {
  const failure = threadLoadFailure(props.error);
  const machine = useMachineSearch();
  return (
    <div role="alert" className="h-full">
      <MissingState
        title={failure.title}
        description={failure.description}
        actions={
          <>
            <Link
              to="/new"
              search={machine}
              className={buttonVariants({ size: "sm", variant: "primary" })}
            >
              New thread
            </Link>
            <Link to="/" className={buttonVariants({ size: "sm" })}>
              Back to Home
            </Link>
          </>
        }
      />
    </div>
  );
}
