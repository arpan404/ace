import type { ProviderLoginProgress } from "@ace/protocol";
import { CheckCircleIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CopyCommand } from "@/components/copy-command.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { DialogFooter } from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { refreshProviders, type ProviderReadiness } from "@/lib/provider-readiness.ts";
import type { LoginController } from "./login-controller.ts";

/** The terminal and its renderer load only when someone opens it. */
const AuthTerminal = lazy(() =>
  import("@/features/panels/index.ts").then((panels) => panels.loadAuthTerminal()),
);

type Manual = NonNullable<ProviderLoginProgress["manual"]>;

/**
 * A sign-in the daemon can't relay (typing an API key, pasting a code, Pi's own `/login`):
 * the exact steps, and an ace terminal running the CLI so the person types it there. The CLI
 * reads the secret itself; ace never sees it. Readiness updates live once the CLI is done.
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
  const signedIn = (terminal !== undefined || exited) && row?.readiness === "signed_in";
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
      {props.message && <p className="text-muted-foreground">{props.message}</p>}
      <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-muted-foreground">
        <li>
          Open a terminal here. It runs <CopyCommand command={manual.command} /> on the computer
          running ace.
        </li>
        <li>{manual.instruction}</li>
        <li>When the CLI says you're signed in, come back here. ace notices on its own.</li>
      </ol>
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
          {opening ? "Opening…" : "Open terminal here"}
        </Button>
      )}
      {failed && (
        <p role="alert" className="text-sm text-status-failed">
          Couldn't open a terminal. Run the command above yourself on the computer running ace.
        </p>
      )}
      {signedIn ? (
        <p role="status" className="flex items-center gap-2">
          <Icon icon={CheckCircleIcon} className="text-status-done" />
          {row.accountLabel ? `Signed in as ${row.accountLabel}` : `Signed in to ${name}`}
        </p>
      ) : (
        exited && (
          <p role="status" className="text-muted-foreground">
            The terminal closed. If you finished signing in, check again.
          </p>
        )
      )}
      <DialogFooter>
        {exited && !signedIn && (
          <Button variant="ghost" onClick={() => refreshProviders(queryClient)}>
            Check again
          </Button>
        )}
        <Button ref={done} variant={signedIn ? "primary" : "ghost"} onClick={props.onClose}>
          {signedIn ? "Done" : "Close"}
        </Button>
      </DialogFooter>
    </>
  );
}
