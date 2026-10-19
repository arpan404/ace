import type { ClientApi } from "@ace/client";
import type { ThreadCatchUpResponse } from "@ace/protocol";
import { catchUpFacts } from "@ace/ui-core";
import { XIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useVisitReadState } from "@/lib/thread-read.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { separated } from "./this-turn.tsx";

/**
 * What the thread did since this device last read it, when it moved on while the person was
 * away: one line of counts and the agent's latest words. It reads the catch-up digest from the
 * cursor the visit began at (ADR 0062), so following the thread now doesn't erase it; Dismiss
 * hides it, and the next visit starts from the cursor this one advanced.
 */
function useCatchUp(threadId: string): {
  catchUp: ThreadCatchUpResponse | undefined;
  since: number | undefined;
} {
  const since = useVisitReadState(threadId).data?.lastSeenSeq;
  const query = useDaemonQuery<ThreadCatchUpResponse>({
    queryKey: ["thread-catch-up", threadId, since],
    read: (client: ClientApi, signal) =>
      client.threadCatchUp({ threadId, sinceSeq: since ?? 0 }, { signal }),
    // A thread never read here has nothing to catch up on: all of it is new.
    enabled: since !== undefined && since > 0,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  return { catchUp: query.data, since };
}

export function CatchUp(props: { catchUp: ThreadCatchUpResponse; onDismiss(): void }) {
  const facts = catchUpFacts(props.catchUp);
  const said = props.catchUp.latestAgentMessagePreview.replace(/\s+/g, " ").trim();
  return (
    <div className="flex min-w-0 items-start gap-2 pl-2">
      <div className="min-w-0 flex-1">
        <p className={`flex min-w-0 flex-wrap gap-x-1 text-ui text-foreground ${separated}`}>
          {facts.map((fact) => (
            <span
              key={fact.text}
              data-tone={fact.tone}
              className={fact.tone ? "text-(--tone-text)" : undefined}
            >
              {fact.text}
            </span>
          ))}
        </p>
        {said && (
          <p className="truncate text-xs text-muted-foreground" title={said}>
            {said}
          </p>
        )}
      </div>
      <IconButton icon={XIcon} label="Dismiss" size="sm" onClick={props.onDismiss} />
    </div>
  );
}

/**
 * The catch-up when it has anything to say and the person hasn't dismissed it. Dismissing is
 * kept with the tab, for the cursor it was read from, so switching tabs doesn't bring it back.
 */
export function useShownCatchUp(threadId: string) {
  const { catchUp, since } = useCatchUp(threadId);
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections;
  const key = `catch-up:${since ?? 0}`;
  const shown =
    !sections?.[key] && catchUp && catchUpFacts(catchUp).length > 0 ? catchUp : undefined;
  const dismiss = () => {
    // Only the latest dismissal is worth keeping: an older cursor never comes back.
    const kept = Object.fromEntries(
      Object.entries(sections ?? {}).filter(([name]) => !name.startsWith("catch-up:")),
    );
    actions.updateUi("work", { sections: { ...kept, [key]: true } });
  };
  return { catchUp: shown, dismiss };
}
