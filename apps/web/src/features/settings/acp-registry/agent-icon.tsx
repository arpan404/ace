import type { RegistryAgent } from "@ace/protocol";
import { monogram } from "@ace/ui-core/acp-registry";
import { useState } from "react";

/**
 * An entry's registry icon, or its initials when it has none or the icon can't load. Registry
 * icons are one-colour `currentColor` SVGs, which draw black in an <img>; dark schemes flip
 * them, so they read as foreground ink in every theme.
 */
export function AgentIcon(props: { agent: Pick<RegistryAgent, "icon" | "name"> }) {
  const [broken, setBroken] = useState(false);
  if (props.agent.icon && !broken)
    return (
      <img
        src={props.agent.icon}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="size-4 shrink-0 opacity-80 dark:invert"
      />
    );
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-xs bg-secondary text-2xs font-semibold text-muted-foreground"
    >
      {monogram(props.agent.name).slice(0, 1)}
    </span>
  );
}
