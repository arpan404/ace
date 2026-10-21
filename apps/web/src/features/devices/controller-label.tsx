import { useAgent } from "@ace/client-react";
import { agentName, agentStatusLabel, type Tone } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";

export type Controller =
  | { kind: "you" }
  | { kind: "nobody" }
  | { kind: "other" }
  | { kind: "agent"; threadId: string; agentId: string };

/** Who drives a device, from its state as this connection sees it. */
export function controllerOf(state: {
  controller: "none" | "human" | "agent";
  ownedHere?: boolean | undefined;
  holder?: { threadId: string; agentId: string } | undefined;
}): Controller {
  if (state.controller === "agent" && state.holder) return { kind: "agent", ...state.holder };
  if (state.controller === "human") return state.ownedHere ? { kind: "you" } : { kind: "other" };
  return { kind: "nobody" };
}

/**
 * An agent driving a device: its provider's mark, its name, and its status as a dot and a word
 * ("driving" while it works, otherwise what it is doing).
 */
export function AgentDriver(props: {
  threadId: string;
  agentId: string;
  className?: string | undefined;
}) {
  const agent = useAgent(props.threadId, props.agentId);
  const name = agent ? agentName(agent) : "An agent";
  const status: { label: string; tone: Tone } = agent
    ? agentStatusLabel(agent.status)
    : { label: "Working", tone: "working" };
  // Short words: holding the device is driving it; otherwise say what keeps it from acting.
  const word =
    status.tone === "working"
      ? "driving"
      : status.tone === "waiting"
        ? "waiting"
        : status.tone === "needs-you"
          ? "needs you"
          : status.tone === "failed"
            ? "failed"
            : "idle";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", props.className)}>
      {agent && (
        <ProviderIcon
          provider={agent.native.provider}
          acpAgentId={agent.native.acpAgentId}
          model={agent.model}
          size={12}
          decorative
        />
      )}
      <span className="truncate text-foreground">{name}</span>
      <span
        data-tone={status.tone}
        className="inline-flex shrink-0 items-center gap-1 text-(--tone-text)"
      >
        <span aria-hidden className="size-1.5 rounded-full bg-(--tone)" />
        {word}
      </span>
    </span>
  );
}

/** The agent driving a device, for its tile; nothing while a person or no one does. */
export function ControllerLabel(props: { controller: Controller; className?: string | undefined }) {
  const { controller } = props;
  if (controller.kind !== "agent") return null;
  return (
    <AgentDriver
      threadId={controller.threadId}
      agentId={controller.agentId}
      className={props.className}
    />
  );
}
