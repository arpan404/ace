import type { ProviderLoginProgress } from "@ace/protocol";
import { signInSteps } from "@ace/ui-core";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CopyIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, type ReactNode } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { Icon } from "@/components/icon.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { DialogFooter } from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import type { LoginController, LoginRefusal, LoginView } from "./login-controller.ts";
import { ManualSteps } from "./manual-steps.tsx";

/*
 * The sign-in dialog's body for each step of the daemon's login session
 * (`ProviderLoginProgress.state`), with the footer that goes with it. The primary action of
 * each step takes focus as the step appears, so the keyboard never lands on nothing.
 */

interface Context {
  name: string;
  logout: boolean;
  row: ProviderReadiness | undefined;
}

const refusals: Record<LoginRefusal, (name: string) => [string, string | undefined]> = {
  forbidden: () => [
    "This device can't sign in providers",
    "Pair it with full access from Settings → Remote devices on the computer running ace.",
  ],
  busy: (name) => [
    `A sign-in for ${name} is already running`,
    "Finish or cancel it where it started, then try again.",
  ],
  unavailable: (name) => [`ace can't run ${name}'s sign-in here`, undefined],
  not_found: () => ["That sign-in has ended", "Start it again."],
  invalid_input: () => ["The CLI didn't take that answer", "Try again."],
  offline: () => ["ace can't reach the daemon", "Reconnect, then try again."],
};

/** "Signed in as ada@example.com": who the provider says is signed in now. */
function signedIn(context: Context): string {
  if (context.logout) return `Signed out of ${context.name}`;
  const label = context.row?.readiness === "signed_in" ? context.row.accountLabel : undefined;
  return label ? `Signed in as ${label}` : `Signed in to ${context.name}`;
}

/** The step in one line: what the dialog says and what a screen reader hears. */
function headline(view: LoginView, context: Context): string {
  if (view.kind === "requesting")
    return context.logout ? "Signing out…" : `Starting ${context.name}'s sign-in…`;
  if (view.kind === "refused") return refusals[view.reason](context.name)[0];
  const progress = view.progress;
  switch (progress.state) {
    case "starting":
      return context.logout ? "Signing out…" : "Opening your browser…";
    case "awaiting_browser":
      return "Finish signing in in your browser";
    case "awaiting_code_entry":
      return "Enter this code in your browser";
    case "awaiting_input":
      return progress.prompt ?? "Choose how to sign in";
    case "verifying":
      return progress.message ?? "Checking the sign-in…";
    case "succeeded":
      return signedIn(context);
    case "cancelled":
      return context.logout ? "Sign-out cancelled" : "Sign-in cancelled";
    case "failed":
      return progress.manual
        ? "Finish in a terminal"
        : (progress.message ?? (context.logout ? "Couldn't sign out" : "Sign-in didn't finish"));
  }
}

/** A step's primary action, focused as the step appears. */
function useFocusOnShow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

export function LoginBody(props: {
  login: LoginController;
  view: LoginView;
  name: string;
  row: ProviderReadiness | undefined;
  onClose(): void;
  onRetry(): void;
}) {
  const { login, view, name, row } = props;
  const context: Context = { name, logout: login.target.action === "logout", row };
  const title = headline(view, context);
  if (view.kind === "requesting") return <Waiting title={title} onCancel={props.onClose} />;
  if (view.kind === "refused") {
    const [, hint] = refusals[view.reason](name);
    return (
      <Problem
        title={title}
        hint={hint ?? manualHint(login.target.provider, name)}
        onClose={props.onClose}
        onRetry={props.onRetry}
      />
    );
  }
  const { progress } = view;
  const notice = view.refused && refusals[view.refused](name).join(". ");
  const cancel = (
    <Button variant="ghost" onClick={() => login.cancel()} disabled={view.sending}>
      Cancel
    </Button>
  );
  switch (progress.state) {
    case "starting":
    case "verifying":
      return <Waiting title={title} onCancel={() => login.cancel()} />;
    case "awaiting_browser":
    case "awaiting_code_entry":
      return (
        <>
          <Challenge progress={progress} />
          <WaitLine text="Waiting for you to finish in the browser…" />
          {notice && <Notice text={notice} />}
          <DialogFooter>{cancel}</DialogFooter>
        </>
      );
    case "awaiting_input":
      return (
        <>
          <Choices
            key={progress.sequence}
            progress={progress}
            title={title}
            disabled={view.sending}
            onChoose={(choice) => login.choose(choice)}
            onContinue={() => login.continue()}
          />
          {notice && <Notice text={notice} />}
          <DialogFooter>{cancel}</DialogFooter>
        </>
      );
    case "succeeded":
      return <Done title={title} onClose={props.onClose} />;
    case "cancelled":
      return <Problem title={title} onClose={props.onClose} onRetry={props.onRetry} quiet />;
    case "failed":
      if (progress.manual)
        return (
          <ManualSteps
            login={login}
            manual={progress.manual}
            message={progress.message}
            name={name}
            row={row}
            onClose={props.onClose}
          />
        );
      return (
        <Problem
          title={title}
          hint={progress.hint}
          onClose={props.onClose}
          onRetry={props.onRetry}
        />
      );
  }
}

/** Where the provider has a terminal recipe, what to run instead. */
function manualHint(provider: ProviderLoginProgress["provider"], name: string) {
  const steps = signInSteps(provider);
  if (!steps) return `Sign in with ${name}'s own setup on the computer running ace.`;
  return steps.prompt
    ? `Run ${steps.run} in a terminal on the computer running ace, then type ${steps.prompt}.`
    : `Run ${steps.run} in a terminal on the computer running ace.`;
}

function Waiting(props: { title: string; onCancel(): void }) {
  const cancel = useFocusOnShow<HTMLButtonElement>();
  return (
    <>
      <WaitLine text={props.title} />
      <DialogFooter>
        <Button ref={cancel} variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function WaitLine(props: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <Spinner />
      {props.text}
    </p>
  );
}

function Notice(props: { text: string }) {
  return (
    <p role="alert" className="text-sm text-status-failed">
      {props.text}
    </p>
  );
}

/** The link to open on this device and, for device sign-in, the code to type there. */
function Challenge(props: { progress: ProviderLoginProgress }) {
  const primary = useFocusOnShow<HTMLAnchorElement>();
  const { url, userCode } = props.progress;
  const toast = useToast();
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.add({ title: `${what} copied` });
    } catch {
      toast.add({ title: `Couldn't copy. Select the ${what.toLowerCase()} and copy it yourself.` });
    }
  };
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {userCode && (
        <>
          <p className="text-sm text-muted-foreground">Your code</p>
          <p className="flex items-center gap-1">
            <span className="font-mono text-lg tracking-[0.12em]" aria-label="Sign-in code">
              {userCode}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void copy(userCode, "Code")}>
              <CopyIcon aria-hidden size={14} />
              Copy code
            </Button>
          </p>
        </>
      )}
      {url && (
        <a
          ref={primary}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "primary" })}
          onClick={(event) => {
            // The desktop app opens it in the system browser; a browser opens a new tab.
            event.preventDefault();
            void openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
          }}
        >
          Open sign-in page
          <ArrowSquareOutIcon aria-hidden size={14} />
        </a>
      )}
      {props.progress.hint && (
        <p className="max-w-[44ch] text-sm text-muted-foreground">{props.progress.hint}</p>
      )}
      {url && (
        <Button size="sm" variant="link" onClick={() => void copy(url, "Link")}>
          Copy link
        </Button>
      )}
    </div>
  );
}

/** The CLI's own question, its answers as buttons (or Continue for a press of Enter). */
function Choices(props: {
  progress: ProviderLoginProgress;
  title: string;
  disabled: boolean | undefined;
  onChoose(choice: string): void;
  onContinue(): void;
}) {
  const primary = useFocusOnShow<HTMLButtonElement>();
  const choices = props.progress.choices ?? [];
  return (
    <div role="group" aria-label={props.title} className="flex flex-col gap-2">
      <p>{props.title}</p>
      {choices.length ? (
        <div className="flex flex-col gap-1.5">
          {choices.map((choice, at) => (
            <Button
              key={choice.id}
              ref={at === 0 ? primary : undefined}
              variant="outline"
              className="justify-start"
              disabled={props.disabled}
              onClick={() => props.onChoose(choice.id)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      ) : (
        <Button
          ref={primary}
          variant="primary"
          className="self-start"
          disabled={props.disabled}
          onClick={props.onContinue}
        >
          Continue
        </Button>
      )}
    </div>
  );
}

function Done(props: { title: string; onClose(): void }) {
  const primary = useFocusOnShow<HTMLButtonElement>();
  return (
    <>
      <Outcome icon={<Icon icon={CheckCircleIcon} size={36} className="text-status-done" />}>
        {props.title}
      </Outcome>
      <DialogFooter>
        <Button ref={primary} variant="primary" onClick={props.onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function Problem(props: {
  title: string;
  hint?: string | undefined;
  onClose(): void;
  onRetry(): void;
  /** Cancelled by the person: nothing went wrong. */
  quiet?: boolean;
}) {
  const primary = useFocusOnShow<HTMLButtonElement>();
  return (
    <>
      <Outcome
        icon={
          props.quiet ? undefined : (
            <Icon icon={WarningCircleIcon} size={36} className="text-status-failed" />
          )
        }
        detail={props.hint}
      >
        {props.title}
      </Outcome>
      <DialogFooter>
        <Button variant="ghost" onClick={props.onClose}>
          Close
        </Button>
        <Button ref={primary} variant="primary" onClick={props.onRetry}>
          Try again
        </Button>
      </DialogFooter>
    </>
  );
}

function Outcome(props: { icon?: ReactNode; children: ReactNode; detail?: string | undefined }) {
  return (
    <div className="flex flex-col items-center gap-2 py-4 text-center">
      {props.icon}
      <p className="text-md font-medium">{props.children}</p>
      {props.detail && <p className="max-w-[44ch] text-sm text-muted-foreground">{props.detail}</p>}
    </div>
  );
}
