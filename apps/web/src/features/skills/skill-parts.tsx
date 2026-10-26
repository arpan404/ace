import type { ProviderKind } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { agentsText } from "./library-model.ts";
import { ProviderMarks } from "./provider-marks.tsx";

/** A skill page's column, title and full description. */
export function SkillHeading(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-title">{props.title}</h2>
      {props.description && (
        <p className="mt-2 max-w-[68ch] text-md text-muted-foreground">{props.description}</p>
      )}
      {props.children}
    </>
  );
}

/**
 * Start a thread with the skill named first in the message, on the person's current agent; the
 * composer sends a leading `/name` as that agent's skill. A project's skill starts in its project.
 */
export function UseInThread(props: { name: string; project?: string | undefined }) {
  return (
    <div className="mt-4">
      <Link
        to="/new"
        search={{ skill: props.name, ...(props.project ? { project: props.project } : {}) }}
        className={buttonVariants({ variant: "primary", size: "sm" })}
      >
        Use in a thread
      </Link>
    </div>
  );
}

/** The agents' marks, then their names: "Claude Code, Codex and OpenCode", "Every agent". */
export function AgentsLine(props: {
  providers: readonly ProviderKind[];
  extra?: string | undefined;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <ProviderMarks providers={props.providers} size={14} decorative />
      <span>
        {agentsText(props.providers)}
        {props.extra && ` · ${props.extra}`}
      </span>
    </span>
  );
}
