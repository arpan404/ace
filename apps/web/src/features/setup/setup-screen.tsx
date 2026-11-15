import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { FirstRunFrame } from "@/components/first-run-frame.tsx";
import { Button } from "@/components/ui/button.tsx";
import { dismissOnboarding } from "@/lib/provider-readiness.ts";
import { newThreadIn } from "@/features/projects/index.ts";
import { chatChoice } from "@/lib/chat-choice.ts";
import { AgentsStep } from "./agents-step.tsx";
import { DoneStep } from "./done-step.tsx";
import { ProjectStep } from "./project-step.tsx";
import { setupSteps, type SetupStep } from "./steps.ts";
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
  const project = step === "done" ? props.project : undefined;
  const index = setupSteps.indexOf(step);
  const back = index > 0 ? setupSteps[index - 1] : undefined;
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
  const done = project !== undefined;
  useEffect(() => {
    if (done) void dismissOnboarding(client, queryClient, true);
  }, [done, client, queryClient]);
  const ready = agents.ready.length;
  const copy = {
    welcome: {
      title: "Welcome to ace",
      lede: "Run the coding agents you already use side by side, and step in only when one needs you.",
    },
    agents: {
      title: "Connect your agents",
      lede: ready
        ? `${ready} ready. Sign in to more now or later in Settings.`
        : "Sign in to one to start.",
    },
    project: { title: "Add your first project", lede: "A folder your agents work in." },
    done: { title: "You're set up", lede: undefined },
  }[step];
  return (
    <FirstRunFrame
      page="setup"
      variant={step}
      corner={
        <span role="status" aria-label={`Step ${index + 1} of ${setupSteps.length}`}>
          {index + 1} of {setupSteps.length}
        </span>
      }
      title={copy.title}
      lede={copy.lede}
      aside={
        !done && (
          // Its words line up with the column's edge, like everything above it.
          <Button variant="ghost" className="-ml-3" onClick={leave}>
            Skip for now
          </Button>
        )
      }
      actions={
        <>
          {back && (
            <Button variant="ghost" onClick={() => props.onStep(back)}>
              Back
            </Button>
          )}
          {step === "welcome" && (
            <Button variant="primary" onClick={() => props.onStep("agents")}>
              Get started
            </Button>
          )}
          {step === "agents" && (
            <Button variant="primary" disabled={!ready} onClick={() => props.onStep("project")}>
              Continue
            </Button>
          )}
          {project && (
            <Button variant="primary" onClick={() => void navigate(newThreadIn(project))}>
              Start a thread
            </Button>
          )}
        </>
      }
    >
      {step === "welcome" && <WelcomeStep agents={agents} />}
      {step === "agents" && <AgentsStep agents={agents} />}
      {step === "project" && (
        <ProjectStep onPicked={(id) => props.onStep("done", id)} onChat={chat} />
      )}
      {project && <DoneStep projectId={project} agents={agents} />}
    </FirstRunFrame>
  );
}
