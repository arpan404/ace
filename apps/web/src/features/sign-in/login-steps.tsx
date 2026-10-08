import type { ProviderLoginProgress } from "@ace/protocol";
import { serviceInfo, signInSteps, apiKeyServiceLabel } from "@ace/ui-core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { ProviderTile } from "@/components/provider-tile.tsx";
import { Button } from "@/components/ui/button.tsx";
import type { ProviderReadiness } from "@/lib/provider-readiness.ts";
import { BrowserStep, ChallengeFooter, CodeStep } from "./login-challenge.tsx";
import type { LoginController, LoginView } from "./login-controller.ts";
import { Done, Problem } from "./login-outcome.tsx";
import { Actions, refusals, Step, StepTitle, useFocusOnShow, Waiting } from "./login-parts.tsx";
import { ApiKeyStep } from "./api-key-step.tsx";
import { AgentLoginTerminal, ManualSteps } from "./manual-steps.tsx";

/*
 * The sign-in dialog's body for each step of the daemon's login session
 * (`ProviderLoginProgress.state`). Each step arrives on its own, its primary action focused.
 */

interface Context {
  name: string;
  logout: boolean;
  /** Connecting or disconnecting one service of OpenCode or Pi ("OpenAI"). */
  service: string | undefined;
  row: ProviderReadiness | undefined;
}

/** How a finished sign-in reads: the title and the line under the check. */
function finished(context: Context): [string, string] {
  if (context.service)
    return context.logout
      ? [`${context.service} is disconnected`, `${context.name} no longer uses it.`]
      : [`${context.service} is connected`, `${context.name} can use its models now.`];
  if (context.logout) return [`Signed out of ${context.name}`, "Sign in again any time."];
  const label = context.row?.readiness === "signed_in" ? context.row.accountLabel : undefined;
  return ["You're signed in", label ? `Signed in as ${label}` : `Signed in to ${context.name}`];
}

/** Where the provider has a terminal recipe, what to run instead. */
function manualHint(provider: ProviderLoginProgress["provider"], name: string) {
  const steps = signInSteps(provider);
  if (!steps) return `Sign in with ${name}'s own setup on the computer running ace.`;
  return steps.prompt
    ? `Or run ${steps.run} in a terminal on the computer running ace, then type ${steps.prompt}.`
    : `Or run ${steps.run} in a terminal on the computer running ace.`;
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
  const context: Context = {
    name,
    logout: login.target.action === "logout",
    service: login.target.service,
    row,
  };
  const starting = context.logout ? "Signing out…" : "Starting sign-in…";
  if (view.kind === "requesting")
    return (
      <Step key="requesting">
        <Pending title={starting} onCancel={props.onClose} />
      </Step>
    );
  if (view.kind === "refused") {
    const [title, hint] = refusals[view.reason](name);
    return (
      <Step key="refused">
        <Problem
          title={title}
          hint={hint ?? manualHint(login.target.provider, name)}
          onClose={props.onClose}
          onRetry={props.onRetry}
        />
      </Step>
    );
  }
  const { progress } = view;
  const notice = view.refused && refusals[view.refused](name).join(". ");
  const cancel = (
    <Button size="sm" variant="ghost" onClick={() => login.cancel()} disabled={view.sending}>
      Cancel
    </Button>
  );
  // One key per step, so a new step replays its entrance and a new snapshot of the same doesn't.
  const key = `${progress.state}:${progress.userCode ?? ""}:${progress.prompt ?? ""}`;
  switch (progress.state) {
    case "starting":
      return (
        <Step key={key}>
          <Pending title={starting} onCancel={() => login.cancel()} />
        </Step>
      );
    case "verifying":
      return (
        <Step key={key}>
          <Pending
            title={progress.message ?? "Checking your sign-in…"}
            onCancel={() => login.cancel()}
          />
        </Step>
      );
    case "awaiting_browser":
    case "awaiting_code_entry": {
      const footer = (
        <>
          {notice && <Notice text={notice} />}
          <ChallengeFooter url={progress.url} cancel={cancel} />
        </>
      );
      return (
        <Step key={key}>
          {progress.userCode ? (
            <CodeStep progress={progress} footer={footer} />
          ) : (
            <BrowserStep
              progress={progress}
              claimOpen={() => login.claimPageOpen()}
              footer={footer}
            />
          )}
        </Step>
      );
    }
    case "awaiting_api_key":
      return (
        <Step key={key}>
          <ApiKeyStep
            name={apiKeyServiceLabel(login.target.provider, login.target.upstream)}
            disabled={view.sending}
            onSubmit={(apiKey) => login.submitApiKey(apiKey)}
            onCancel={() => login.cancel()}
          />
          {notice && <Notice text={notice} />}
        </Step>
      );
    case "awaiting_input":
      if (progress.manual?.terminalId)
        return (
          <AgentLoginTerminal
            id={progress.manual.terminalId}
            name={name}
            cancel={() => login.cancel()}
          />
        );
      return (
        <Step key={key}>
          {progress.choices?.length ? (
            <Choices
              progress={progress}
              provider={login.target.provider}
              upstreams={login.target.provider === "opencode" || login.target.provider === "pi"}
              disabled={view.sending}
              onChoose={(choice) => login.choose(choice)}
            />
          ) : (
            <Continue
              prompt={progress.prompt}
              disabled={view.sending}
              onContinue={() => login.continue()}
            />
          )}
          {notice && <Notice text={notice} />}
          <div className="flex justify-end border-t pt-3">{cancel}</div>
        </Step>
      );
    case "succeeded": {
      const [title, line] = finished(context);
      return (
        <Step key={key}>
          <Done title={title} line={line} onClose={props.onClose} />
        </Step>
      );
    }
    case "cancelled":
      return (
        <Step key={key}>
          <Problem
            title={context.logout ? "Sign-out cancelled" : "Sign-in cancelled"}
            hint="Nothing changed."
            onClose={props.onClose}
            onRetry={props.onRetry}
            quiet
          />
        </Step>
      );
    case "failed":
      if (progress.manual)
        return (
          <Step key={key}>
            <ManualSteps
              login={login}
              manual={progress.manual}
              message={progress.message}
              name={name}
              row={row}
              onClose={props.onClose}
            />
          </Step>
        );
      return (
        <Step key={key}>
          <Problem
            title={context.logout ? "Couldn't sign out" : "Sign-in didn't finish"}
            hint={[progress.message, progress.hint].filter(Boolean).join(" ") || undefined}
            onClose={props.onClose}
            onRetry={props.onRetry}
          />
        </Step>
      );
  }
}

/** Something is on its way: the header's mark breathes meanwhile. */
function Pending(props: { title: string; onCancel(): void }) {
  const cancel = useFocusOnShow<HTMLButtonElement>();
  return (
    <>
      <Waiting text={props.title} />
      <Actions>
        <Button ref={cancel} size="lg" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </Actions>
    </>
  );
}

function Notice(props: { text: string }) {
  return (
    <p role="alert" className="text-center text-sm text-status-failed">
      {props.text}
    </p>
  );
}

/**
 * The CLI's own choices as a list: each with its mark and what connecting it means. For OpenCode
 * and Pi they are the services it can reach models through.
 */
function Choices(props: {
  progress: ProviderLoginProgress;
  provider: ProviderLoginProgress["provider"];
  upstreams: boolean;
  disabled: boolean | undefined;
  onChoose(choice: string): void;
}) {
  const primary = useFocusOnShow<HTMLButtonElement>();
  const choices = props.progress.choices ?? [];
  const title = props.upstreams
    ? "Which service do you want to connect?"
    : (props.progress.prompt ?? "Choose how to sign in");
  return (
    <>
      <StepTitle title={title} line={props.upstreams ? "You can add more later." : undefined} />
      <ul
        role="group"
        aria-label={title}
        className="flex flex-col overflow-hidden rounded-card border bg-card"
      >
        {choices.map((choice, at) => {
          const description = serviceInfo(choice.id).description;
          return (
            <li key={choice.id} className="border-t first:border-t-0">
              <button
                ref={at === 0 ? primary : undefined}
                type="button"
                aria-label={choice.label}
                disabled={props.disabled}
                onClick={() => props.onChoose(choice.id)}
                className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-(--dur-1) focus-ring-inset hover:bg-accent disabled:opacity-50"
              >
                <ProviderTile
                  provider={props.provider}
                  service={{ id: choice.id, label: choice.label }}
                  size="sm"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-foreground">{choice.label}</span>
                  {description && (
                    <span className="truncate text-sm text-muted-foreground">{description}</span>
                  )}
                </span>
                <CaretRightIcon
                  aria-hidden
                  size={14}
                  className="text-subtle-foreground transition-transform duration-(--dur-1) group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The CLI's fixed prompt ("Press Enter to continue."), answered with Continue. */
function Continue(props: {
  prompt: string | undefined;
  disabled: boolean | undefined;
  onContinue(): void;
}) {
  const primary = useFocusOnShow<HTMLButtonElement>();
  return (
    <>
      <StepTitle title="One more step" line={props.prompt} />
      <Actions>
        <Button
          ref={primary}
          size="lg"
          variant="primary"
          disabled={props.disabled}
          onClick={props.onContinue}
        >
          Continue
        </Button>
      </Actions>
    </>
  );
}
