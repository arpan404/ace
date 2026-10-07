import type { ProviderLoginProgress } from "@ace/protocol";
import { CheckIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { refreshProviders, type ProviderReadiness } from "@/lib/provider-readiness.ts";
import type { LoginController } from "./login-controller.ts";
import { StepTitle } from "./login-parts.tsx";

/** The terminal and its renderer load only when someone opens it. */
const AuthTerminal = lazy(() =>
  import("@/features/panels/index.ts").then((panels) => panels.loadAuthTerminal()),
);

type Manual = NonNullable<ProviderLoginProgress["manual"]>;

/** One numbered step: its number in a ring that fills once the step is done. */
function Numbered(props: { n: number; done?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-sm font-medium transition-colors duration-(--dur-2)",
          props.done
            ? "bg-status-done text-background"
            : "bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
        )}
      >
        {props.n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">{props.children}</div>
    </li>
  );
}

/**
 * A sign-in the daemon can't relay (typing an API key, pasting a code, Pi's own `/login`): three
 * plain steps, and an ace terminal running the CLI where step one is, so the person types it
 * there. The CLI reads the secret itself; ace never sees it. Readiness updates live once the
 * CLI is done.
 */
export function ManualSteps(props: {
  login: LoginController;
  manual: Manual;
  message: string | undefined;
  name: string;
  row: ProviderReadiness | undefined;
  onClose(): void;
}) {
  const { manual, name, row } = props;
  const queryClient = useQueryClient();
  const [terminal, setTerminal] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const [exited, setExited] = useState(false);
  const open = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  // The CLI exited and the provider reads signed in: the terminal stays, so its last words do.
  const signedIn = exited && row?.readiness === "signed_in";
  useEffect(() => {
    (signedIn ? done : open).current?.focus();
  }, [signedIn]);
  const start = async () => {
    setOpening(true);
    setFailed(false);
    const id = await props.login.openTerminal();
    setOpening(false);
    if (id) setTerminal(id);
    else setFailed(true);
  };
  return (
    <>
      <StepTitle
        title="Finish in a terminal"
        line={
          props.message ??
          `This step asks for something only ${name} should see, like an API key. You type it straight into ${name}.`
        }
      />
      <ol className="flex flex-col gap-4 rounded-card border bg-card p-4">
        <Numbered n={1} done={terminal !== undefined}>
          <p>
            Open {name} in a terminal here. It runs <CopyCommand command={manual.command} />
          </p>
          {terminal ? (
            <Suspense
              fallback={
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Spinner />
                  Opening the terminal…
                </p>
              }
            >
              <AuthTerminal
                terminalId={terminal}
                label={`${name} sign-in`}
                onExit={() => {
                  setExited(true);
                  refreshProviders(queryClient);
                }}
              />
            </Suspense>
          ) : (
            <Button
              ref={open}
              variant="primary"
              className="self-start"
              disabled={opening}
              onClick={() => void start()}
            >
              <TerminalWindowIcon aria-hidden size={14} />
              {opening ? "Opening…" : "Open terminal"}
            </Button>
          )}
          {failed && (
            <p role="alert" className="text-sm text-status-failed">
              Couldn't open a terminal. Run the command yourself on the computer running ace.
            </p>
          )}
        </Numbered>
        <Numbered n={2} done={signedIn}>
          <p>{manual.instruction}</p>
        </Numbered>
        <Numbered n={3} done={signedIn}>
          {signedIn ? (
            <p role="status" className="flex items-center gap-1.5 font-medium">
              <CheckIcon aria-hidden size={14} weight="bold" className="text-status-done" />
              {row.accountLabel ? `Signed in as ${row.accountLabel}` : `Signed in to ${name}`}
            </p>
          ) : (
            <p className="text-muted-foreground">
              When {name} says you're signed in, you're done. ace notices on its own.
            </p>
          )}
        </Numbered>
      </ol>
      {exited && !signedIn && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          The terminal closed. If you finished signing in, check again.
        </p>
      )}
      <div className="flex justify-end gap-2 border-t pt-3">
        {exited && !signedIn && (
          <Button size="sm" variant="ghost" onClick={() => refreshProviders(queryClient)}>
            Check again
          </Button>
        )}
        <Button
          ref={done}
          size="sm"
          variant={signedIn ? "primary" : "ghost"}
          onClick={props.onClose}
        >
          {signedIn ? "Done" : "Close"}
        </Button>
      </div>
    </>
  );
}
