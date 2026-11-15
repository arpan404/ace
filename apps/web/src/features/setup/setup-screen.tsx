import { useClient } from "@ace/client-react";
import { ArrowRightIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Button } from "@/components/ui/button.tsx";
import { part } from "@/lib/suit-part.ts";
import { dismissOnboarding } from "@/lib/provider-readiness.ts";
import { Screen } from "@/features/shell/index.ts";
import { newThreadIn } from "@/features/projects/index.ts";
import { chatChoice } from "@/lib/chat-choice.ts";
import { AgentsStep } from "./agents-step.tsx";
import { DoneStep } from "./done-step.tsx";
import { ProjectStep } from "./project-step.tsx";
import { setupSteps, stepNames, type SetupStep } from "./steps.ts";
import { useAgentCards } from "./use-agent-cards.ts";
import { WelcomeStep } from "./welcome-step.tsx";

/**
 * First-run setup (`/setup`), four steps: Welcome (what ace found on this computer), Agents
 * (each ready, or with the one step that readies it; rows move as sign-ins finish anywhere),
 * Project (a source opens Add project on it, and adding comes back to Done) and Done (the
 * project and the ready agents, then the first thread). The step lives in the URL, so the
 * browser's Back works. Done, skipped or left for a chat, it stays dismissed for this device.
 */
export function SetupScreen(props: {
  step: SetupStep;
  project?: string | undefined;
  onStep(step: SetupStep, project?: string): void;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const agents = useAgentCards();
  // Done needs its project; without one it is still the project step.
  const step = props.step === "done" && !props.project ? "project" : props.step;
  const index = setupSteps.indexOf(step);
  const dismiss = () => void dismissOnboarding(client, queryClient, true);
  const leave = () => {
    dismiss();
    void navigate({ to: "/" });
  };
  const chat = () => {
    dismiss();
    void navigate({ to: "/new", search: { project: chatChoice } });
  };
  // Reaching Done is finishing setup: a reload or another window goes Home from here on.
  const done = step === "done";
  useEffect(() => {
    if (done) void dismissOnboarding(client, queryClient, true);
  }, [done, client, queryClient]);
  const back = index > 0 ? setupSteps[index - 1] : undefined;
  const project = done ? props.project : undefined;
  return (
    <Screen title="Set up" page="setup" pageVariant={step}>
      <div className="flex h-full min-h-0 flex-col">
        <div {...part("page-body")} className="min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10">
          <div
            key={step}
            className="fx-view-in mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center gap-8"
          >
            {step === "welcome" && <WelcomeStep agents={agents} />}
            {step === "agents" && <AgentsStep agents={agents} />}
            {step === "project" && (
              <ProjectStep onPicked={(id) => props.onStep("done", id)} onChat={chat} />
            )}
            {project && <DoneStep projectId={project} agents={agents} />}
          </div>
        </div>
        {/* Skip stays in one place on every step; Back sits beside the step's own action. */}
        <div {...part("page-toolbar")} className="shrink-0 px-6 py-5 sm:px-10">
          <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-4 sm:grid sm:grid-cols-[1fr_auto_1fr]">
            <div>
              {!done && (
                <Button variant="secondary" onClick={leave}>
                  Skip for now
                </Button>
              )}
            </div>
            <ol
              aria-label={`Step ${index + 1} of ${setupSteps.length}`}
              {...part("progress", undefined, "steps")}
              // A phone's footer is just its buttons; the step still reads aloud.
              className="flex items-center gap-2 max-sm:sr-only"
            >
              {setupSteps.map((each, at) => (
                <li
                  key={each}
                  aria-current={at === index ? "step" : undefined}
                  className={
                    at === index
                      ? "h-1.5 w-5 rounded-full bg-foreground"
                      : at < index
                        ? "size-1.5 rounded-full bg-muted-foreground"
                        : "size-1.5 rounded-full bg-muted-foreground/30"
                  }
                >
                  <span className="sr-only">{stepNames[each]}</span>
                </li>
              ))}
            </ol>
            <div className="flex justify-end gap-2">
              {back && (
                <Button variant="ghost" onClick={() => props.onStep(back)}>
                  Back
                </Button>
              )}
              {step === "welcome" && (
                <Button variant="primary" onClick={() => props.onStep("agents")}>
                  Get started
                  <ArrowRightIcon aria-hidden size={14} />
                </Button>
              )}
              {step === "agents" && (
                <Button
                  variant="primary"
                  disabled={!agents.ready.length}
                  onClick={() => props.onStep("project")}
                >
                  Continue
                  <ArrowRightIcon aria-hidden size={14} />
                </Button>
              )}
              {project && (
                <Button variant="primary" onClick={() => void navigate(newThreadIn(project))}>
                  Start a thread
                  <ArrowRightIcon aria-hidden size={14} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Screen>
  );
}
