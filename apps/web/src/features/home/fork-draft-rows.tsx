import { useSidebarThread } from "@ace/client-react";
import { projectBadge } from "@ace/ui-core";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ProjectMark } from "@/components/project-mark.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { undoWindowMs } from "@/features/organize/index.ts";
import {
  discardDraft,
  forkDraftKey,
  readDraft,
  removeForkDraft,
  saveForkDraft,
  useForkDrafts,
  writeDraft,
  type ForkDraft,
} from "@/features/thread/index.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";

const refused = "Couldn't discard the fork draft on this device. Free space and try again.";

/**
 * Forks opened and not sent yet, beside New thread's drafts: each reopens its fork with the
 * message kept. Nothing exists on the daemon until that message is sent. Discard takes a row away
 * at once, with Undo.
 */
export function ForkDraftRows() {
  const identity = useHostIdentity();
  const host = identity?.hostId;
  const { storage } = useLayout();
  const drafts = useForkDrafts(storage, host);
  const discard = useDiscardForkDraft();
  const [error, setError] = useState<string>();
  if (!host || !drafts.length) return null;
  return (
    <>
      <ul aria-label="Fork drafts" className="pb-1">
        {drafts.map((draft) => (
          <ForkDraftRow
            key={forkDraftKey(draft)}
            draft={draft}
            machine={identity}
            onDiscard={() => void discard(host, draft).then(setError)}
          />
        ))}
      </ul>
      {error && (
        <p role="alert" className="px-4 text-xs text-status-failed">
          {error}
        </p>
      )}
    </>
  );
}

function ForkDraftRow(props: {
  draft: ForkDraft;
  machine: ReturnType<typeof useHostIdentity>;
  onDiscard(): void;
}) {
  const parent = useSidebarThread(props.draft.threadId);
  const directory = useProjectDirectory();
  const title = `${parent?.title ?? "Thread"} (fork)`;
  const project = parent?.workspaceId;
  return (
    <li className="group/draft relative mb-1 rounded-md transition-colors duration-(--motion-fast) hover:bg-accent">
      <Link
        data-row-focus=""
        to="/t/$threadId/fork"
        params={{ threadId: props.draft.threadId }}
        search={{ run: props.draft.run, item: props.draft.item }}
        aria-label={`${title}. Fork draft${project ? `, Project ${directory.name(project)}` : ""}`}
        className="flex h-20 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md px-2.5 py-3 text-ui focus-ring-inset"
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {project && (
            <ProjectMark
              id={project}
              badge={projectBadge({ id: project, name: directory.name(project) })}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{project ? directory.name(project) : ""}</span>
          <span>Draft</span>
        </span>
        <span className="truncate text-base leading-5 text-foreground">{title}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MachineMark icon={props.machine?.icon} />
          <span className="min-w-0 truncate">{props.machine?.displayName ?? "This machine"}</span>
          {parent?.provider && (
            <ProviderIcon provider={parent.provider} size={14} className="ml-auto" decorative />
          )}
        </span>
      </Link>
      <button
        type="button"
        aria-label={`Discard fork draft of ${parent?.title ?? "this thread"}`}
        className="absolute right-2 bottom-2 rounded-sm bg-sidebar px-2 py-1 text-xs text-muted-foreground opacity-0 focus-ring group-hover/draft:opacity-100 group-focus-within/draft:opacity-100 hover:text-foreground pointer-coarse:opacity-100"
        onClick={props.onDiscard}
      >
        Discard
      </button>
    </li>
  );
}

/**
 * Discarding a fork draft forgets it and its message on this device, with Undo putting both back.
 * When its page is open, the parent thread opens instead.
 */
function useDiscardForkDraft() {
  const { storage } = useLayout();
  const toast = useToast();
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const search = useSearch({ strict: false });
  return async (host: string, draft: ForkDraft): Promise<string | undefined> => {
    const key = forkDraftKey(draft);
    const open =
      path === `/t/${draft.threadId}/fork` &&
      search.run === draft.run &&
      search.item === draft.item;
    // An open fork saves its message as it closes: leave it first, so Undo has every word.
    if (open) await navigate({ to: "/t/$threadId", params: { threadId: draft.threadId } });
    const message = readDraft(storage, key);
    if (!discardDraft(storage, key)) return refused;
    if (!removeForkDraft(storage, host, key)) {
      writeDraft(storage, key, message);
      return refused;
    }
    toast.add({
      title: "Fork draft discarded",
      timeout: undoWindowMs,
      undo: () => {
        const restored = writeDraft(storage, key, message) && saveForkDraft(storage, host, draft);
        if (!restored) toast.error({ title: "Couldn't bring the fork draft back" });
      },
    });
    return undefined;
  };
}
