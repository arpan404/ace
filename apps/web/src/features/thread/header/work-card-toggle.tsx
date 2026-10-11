import { useCheckoutState } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useThreadMeta } from "@ace/client-react";
import { useMutationState } from "@tanstack/react-query";
import { ListBulletsIcon } from "@phosphor-icons/react";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useWorkCardLive, agentNeedsYou, agentRunning } from "./work-card-live.ts";

/** The existing entry point, with a summary of pending checkout and thread work. */
export function WorkCardToggle(props: { thread: ThreadRef; open: boolean; onClick(): void }) {
  const meta = useThreadMeta(props.thread.id);
  const { agents, tasks } = useWorkCardLive(props.thread.id);
  const details = meta?.details;
  const changed = details?.diff?.files ?? 0;
  const running = agents.filter(agentRunning).length;
  const failedPush =
    useMutationState({
      filters: { mutationKey: ["thread", props.thread.id, "git-change"] },
      select: (mutation) => mutation.state.status === "error",
    }).at(-1) ?? false;
  const { status } = useCheckoutState(props.thread);
  const failedChecks = status?.ci === "failure";
  const needsYou =
    agents.some(agentNeedsYou) ||
    meta?.status.state === "needs_you" ||
    meta?.status.state === "failed" ||
    failedPush ||
    failedChecks;
  const prs = details?.linkedPrs ?? (details?.linkedPr ? [details.linkedPr] : []);
  const summary =
    [
      changed > 0 && `${changed} changed`,
      ...prs.map((pr) => `PR #${pr.number}`),
      running > 0 && `${running} ${running === 1 ? "agent" : "agents"} running`,
      tasks.length > 0 &&
        `${tasks.length} background ${tasks.length === 1 ? "command" : "commands"}`,
      needsYou && "Needs you",
    ]
      .filter(Boolean)
      .join(" · ") || "Nothing pending";
  const tone = needsYou
    ? "needs-you"
    : changed > 0 || running > 0 || tasks.length > 0
      ? "working"
      : undefined;
  return (
    <span className="relative inline-flex">
      <IconButton
        icon={ListBulletsIcon}
        label={`Work card · ${summary}`}
        tip={summary}
        shortcut="workCard"
        pressed={props.open}
        data-work-card-toggle
        onClick={props.onClick}
      />
      {tone && (
        <Dot
          tone={tone}
          label={needsYou ? "Work needs you" : "Work pending"}
          className="pointer-events-none absolute top-1 right-1"
        />
      )}
    </span>
  );
}
