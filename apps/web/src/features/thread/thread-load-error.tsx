import { WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";

/** The daemon has no such thread: deleted, or it belongs to another daemon. */
const missing = new Set(["not_found", "thread_not_found"]);
/** The connection failed, not the thread: the agents on the daemon carry on regardless. */
const transport = new Set(["offline", "timeout", "unavailable"]);

/** What a thread that couldn't be opened says, in words; the raw code waits behind Details. */
export function threadLoadFailure(error: unknown): {
  title: string;
  description: string;
  code: string;
} {
  const code = daemonErrorCode(error);
  if (missing.has(code))
    return {
      title: "This thread doesn't exist",
      description: "It may have been deleted or belong to another daemon.",
      code,
    };
  const reason = describeDaemonError(code);
  return {
    title: "This thread couldn't be loaded",
    description: transport.has(code) ? `${reason} The agents keep working.` : reason,
    code,
  };
}

/** The thread screen when its thread couldn't be opened: why, the way Home, and the code. */
export function ThreadLoadError(props: { error: unknown }) {
  const failure = threadLoadFailure(props.error);
  return (
    <div role="alert" className="h-full">
      <EmptyState
        icon={WarningCircleIcon}
        title={failure.title}
        description={failure.description}
        action={
          <div className="flex flex-col items-center gap-3">
            <Link to="/" className={buttonVariants({ size: "sm" })}>
              Back to Home
            </Link>
            <details className="text-xs text-subtle-foreground">
              <summary className="cursor-pointer select-none hover:text-muted-foreground">
                Details
              </summary>
              <p className="mt-1">
                The daemon said: <code className="font-mono">{failure.code}</code>
              </p>
            </details>
          </div>
        }
      />
    </div>
  );
}
