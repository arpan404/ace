import { threadStatusLabel } from "@ace/ui-core";
import { useCheckoutState } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useThreadMeta } from "@ace/client-react";
import { useMutationState } from "@tanstack/react-query";
import { ListBulletsIcon } from "@phosphor-icons/react";
import { Dot } from "@/components/ui/dot.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useWorkCardLive, agentNeedsYou, agentRunning } from "./work-card-live.ts";
import { useThreadLiveState } from "../lib/live-state.ts";

/** The existing entry point, with a summary of pending checkout and thread work. */
export function WorkCardToggle(props: { thread: ThreadRef; open: boolean; onClick(): void }) {
  const meta = useThreadMeta(props.thread.id);
  const { agents, tasks } = useWorkCardLive(props.thread.id);
  const live = useThreadLiveState(props.thread.id);
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
      running > 0 &&
        `${running} ${running === 1 ? "agent" : "agents"}${live.fresh ? " running" : ""}`,
      tasks.length > 0 &&
        `${tasks.length} background ${tasks.length === 1 ? "command" : "commands"}`,
      needsYou && "Needs you",
      meta &&
        !needsYou &&
        ["waiting", "limited", "unresponsive"].includes(meta.status.state) &&
        threadStatusLabel(meta.status).label,
      meta?.status.state === "working" && running === 0 && "Working",
    ]
      .filter(Boolean)
      .join(" · ") || "Nothing pending";
  const label = live.fresh ? summary : `${live.staleLabel} · Last seen: ${summary}`;
  const tone = needsYou
    ? "needs-you"
    : !live.fresh
      ? "limited"
      : meta && ["waiting", "limited", "unresponsive"].includes(meta.status.state)
        ? "limited"
        : changed > 0 || running > 0 || tasks.length > 0 || meta?.status.state === "working"
          ? "working"
          : undefined;
  return (
    <span className="relative inline-flex">
      <Tip label={label} shortcut="workCard">
        <Button
          variant="ghost"
          aria-label={`Work card · ${label}`}
          aria-expanded={props.open}
          aria-controls="work-card"
          data-work-card-toggle
          className="rounded-full gap-2"
          onClick={props.onClick}
        >
          <ListBulletsIcon aria-hidden size={16} />
          Work
          {tone && (
            <Dot
              tone={tone}
              label={needsYou ? "Work needs you" : live.fresh ? "Work pending" : "Work last seen"}
            />
          )}
        </Button>
      </Tip>
    </span>
  );
}
