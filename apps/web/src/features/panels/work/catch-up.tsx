import type { ClientApi } from "@ace/client";
import type { ThreadCatchUpResponse } from "@ace/protocol";
import { catchUpFacts } from "@ace/ui-core";
import { useState } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useVisitReadState } from "@/lib/thread-read.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { QuietLink } from "./summary-section.tsx";

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
 * What happened since the person last looked, folded to one quiet line, "2 updates since you
 * looked · Show", that opens its two to four plain bullet lines in place (the counts, each on its
 * own line, then the agent's latest words). Clear dismisses it.
 */
export function SinceYouLooked(props: { catchUp: ThreadCatchUpResponse; onDismiss(): void }) {
  const [open, setOpen] = useState(false);
  const facts = catchUpFacts(props.catchUp);
  const said = props.catchUp.latestAgentMessagePreview.replace(/\s+/g, " ").trim();
  const lines = [
    ...facts.slice(0, said ? 3 : 4).map((fact) => ({ text: fact.text, tone: fact.tone })),
    ...(said ? [{ text: said, tone: undefined }] : []),
  ];
  return (
    <section aria-label="Since you looked" className="min-w-0 px-2 text-xs">
      <p className="flex min-w-0 items-center gap-1 text-muted-foreground">
        <span className="min-w-0 truncate">
          {lines.length === 1 ? "1 update" : `${lines.length} updates`} since you looked
        </span>
        <span aria-hidden className="text-subtle-foreground">
          ·
        </span>
        <QuietLink expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </QuietLink>
        <span aria-hidden className="text-subtle-foreground">
          ·
        </span>
        <QuietLink onClick={props.onDismiss}>Clear</QuietLink>
      </p>
      {open && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ui text-muted-foreground marker:text-subtle-foreground">
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
      )}
    </section>
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
