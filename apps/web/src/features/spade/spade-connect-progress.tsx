import { cn } from "@/lib/cn.ts";
import { blockedSignIn, connectProgress, type ConnectPhase } from "./use-connect-app.ts";

/**
 * A connection in progress in one line: what to do in the browser, with Cancel. When the browser
 * blocked the sign-in's tab, a link opens it (a click the browser lets through). Nothing while no
 * connection is under way.
 */
export function ConnectProgress(props: {
  phase: ConnectPhase;
  name: string;
  onCancel(): void;
  className?: string;
}) {
  const line = connectProgress(props.phase, props.name);
  if (!line) return null;
  const blocked = blockedSignIn(props.phase);
  return (
    <p aria-live="polite" className={cn("flex flex-wrap items-baseline gap-x-2", props.className)}>
      <span className="min-w-0">{line}</span>
      {blocked && (
        <a
          href={blocked}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-sm font-medium text-foreground focus-ring hover:underline"
        >
          {`Open ${props.name}'s sign-in`}
        </a>
      )}
      <button
        type="button"
        onClick={props.onCancel}
        className="shrink-0 rounded-sm font-medium text-muted-foreground focus-ring hover:text-foreground hover:underline"
      >
        Cancel
      </button>
    </p>
  );
}
