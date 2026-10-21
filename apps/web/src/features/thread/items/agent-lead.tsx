import type { ProviderKind } from "@ace/protocol";
import { providerSlots } from "@ace/ui-core";
import { RobotIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * What leads a row of agents: their providers' marks, plain glyphs with no tile, ring, status dot
 * or account badge. State is the row's words, never the lead's.
 */

/** A provider and the model its first agent runs, which may pick the provider's mark. */
export interface AgentMark {
  provider?: ProviderKind | undefined;
  model?: string | undefined;
}

/** One agent's mark: its provider's, else a robot while the provider isn't known. */
export function AgentIcon(props: AgentMark & { size: 18 | 20; className?: string | undefined }) {
  return props.provider ? (
    <ProviderIcon
      provider={props.provider}
      model={props.model}
      size={props.size}
      className={props.className}
      decorative
    />
  ) : (
    <RobotIcon
      aria-hidden
      size={props.size}
      className={cn("text-muted-foreground", props.className)}
    />
  );
}

/**
 * A later mark tucks under the one before it: cut out where that mark sits (its centre 7px left
 * of this one's edge, for 20px marks 3px apart), so the earlier mark reads as in front.
 */
const tucked: CSSProperties = {
  maskImage: "radial-gradient(circle at -7px 50%, transparent 11px, #000 11.5px)",
};

/**
 * A group's lead: each provider once, in launch order, in at most three slots; past three, two
 * marks and "+N". Named for assistive tech ("Claude Code, Codex and 2 more") unless `decorative`.
 */
export function ProvidersLead(props: { agents: readonly AgentMark[]; decorative?: boolean }) {
  const slots = providerSlots(props.agents.map((agent) => agent.provider));
  const modelOf = (provider: ProviderKind | undefined) =>
    props.agents.find((agent) => agent.provider === provider)?.model;
  return (
    <span
      {...(props.decorative ? { "aria-hidden": true } : { role: "img", "aria-label": slots.label })}
      data-lead="providers"
      className="flex min-w-5 shrink-0 items-center"
    >
      {slots.shown.map((provider, index) => (
        <span
          key={provider ?? "unknown"}
          data-provider={provider ?? "unknown"}
          className={cn("flex size-5 shrink-0", index > 0 && "-ml-[3px]")}
          style={index > 0 ? tucked : undefined}
        >
          <AgentIcon provider={provider} model={modelOf(provider)} size={20} />
        </span>
      ))}
      {slots.more > 0 && (
        <span className="ml-[5px] text-xs font-medium text-muted-foreground tabular-nums">
          +{slots.more}
        </span>
      )}
    </span>
  );
}
