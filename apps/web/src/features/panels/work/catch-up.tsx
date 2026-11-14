import type { ClientApi } from "@ace/client";
import type { ThreadCatchUpResponse } from "@ace/protocol";
import { catchUpFacts, catchUpLines } from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useVisitReadState } from "@/lib/thread-read.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { QuietLink, Section } from "./summary-section.tsx";

/**
 * What the thread did since this device last read it, when it moved on while the person was
 * away: its counts and the agent's latest words. It reads the catch-up digest from the
 * cursor the visit began at (ADR 0062), so following the thread now doesn't erase it; Clear
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

/**
 * What happened since the person last looked, two to four plain lines: the counts, each on its
 * own line, then the agent's latest words. Clear dismisses it.
 */
export function SinceYouLooked(props: { catchUp: ThreadCatchUpResponse; onDismiss(): void }) {
  const lines = catchUpLines(props.catchUp);
  return (
    <Section name="Since you looked" aside={<QuietLink onClick={props.onDismiss}>Clear</QuietLink>}>
      <ul className="list-disc space-y-0.5 pl-4 text-ui text-muted-foreground marker:text-subtle-foreground">
        {lines.map((line) => (
          <li
            key={line.text}
            data-tone={line.tone}
            className={line.tone ? "truncate text-(--tone-text)" : "truncate"}
            title={line.text}
          >
            {line.text}
          </li>
        ))}
      </ul>
    </Section>
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
