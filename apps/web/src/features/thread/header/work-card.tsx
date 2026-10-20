import { useThreadMeta } from "@ace/client-react";
import { lazy, Suspense, useState } from "react";
import { fileTab, loadCreateFile } from "@/features/panels/index.ts";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { WorkspaceGroup } from "./work-card-workspace.tsx";
import { BranchGroup } from "./work-card-branch.tsx";
import { AgentsSection } from "./work-card-agents.tsx";

const CreateFile = lazy(() => loadCreateFile().then((module) => ({ default: module.CreateFile })));

/**
 * The thread details card's sections: Workspace, Branch and Agents (a child thread's parent,
 * else the main agent's subagents), a hairline between each. What runs in detail (the agent
 * tree, background commands, automations) has one home, the Summary tab. Its forms (commit,
 * PR, a guarded checkout move, a new script file) outlive the card, which closes when one opens.
 */
export function WorkCard(props: { threadId: string; onClose(): void }) {
  const meta = useThreadMeta(props.threadId);
  if (!meta)
    return (
      // Rows shaped like the card's, while the thread's facts arrive.
      <ListSkeleton label="thread details" shape="row" rows={3} className="px-1.5 py-1.5" />
    );
  return (
    <WorkGroups
      thread={{
        id: props.threadId,
        workspaceId: meta.workspaceId,
        title: meta.title,
        provider: meta.provider,
      }}
      onClose={props.onClose}
    />
  );
}

function WorkGroups(props: { thread: ThreadRef; onClose(): void }) {
  const git = useGitFlow(props.thread);
  const checkout = useCheckoutMove(props.thread);
  const workspace = useWorkspaceActions(props.thread.id);
  const [addingScript, setAddingScript] = useState(false);
  return (
    <>
      <WorkspaceGroup
        thread={props.thread}
        move={checkout.move}
        onClose={props.onClose}
        onAddScript={() => setAddingScript(true)}
      />
      <BranchGroup thread={props.thread} git={git} move={checkout.move} onClose={props.onClose} />
      <AgentsSection threadId={props.thread.id} onClose={props.onClose} />
      {git.dialog}
      {checkout.dialog}
      {addingScript && (
        <Suspense fallback={null}>
          <CreateFile
            threadId={props.thread.id}
            onClose={() => setAddingScript(false)}
            onCreated={(path) => workspace.open(fileTab(path))}
          />
        </Suspense>
      )}
    </>
  );
}
