import { useThreadMeta } from "@ace/client-react";
import { lazy, Suspense, useState } from "react";
import { fileTab, loadCreateFile } from "@/features/panels/index.ts";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { EnvironmentGroup } from "./work-card-environment.tsx";
import { GitGroup } from "./work-card-git.tsx";
import { LineageSection } from "./work-card-lineage.tsx";
import { RunningGroup } from "./work-card-running.tsx";

const CreateFile = lazy(() => loadCreateFile().then((module) => ({ default: module.CreateFile })));

/**
 * The thread details card's sections: Environment, Git, Lineage (a child thread's parent) and
 * Running, a hairline between each. Its forms (commit, PR, a guarded
 * checkout move, a new script file) outlive the card, which closes when one opens.
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
      workspacePath={meta.details?.workspace?.path}
      onClose={props.onClose}
    />
  );
}

function WorkGroups(props: {
  thread: ThreadRef;
  workspacePath: string | undefined;
  onClose(): void;
}) {
  const git = useGitFlow(props.thread);
  const checkout = useCheckoutMove(props.thread);
  const workspace = useWorkspaceActions(props.thread.id);
  const [addingScript, setAddingScript] = useState(false);
  return (
    <>
      <EnvironmentGroup
        thread={props.thread}
        move={checkout.move}
        onClose={props.onClose}
        onAddScript={() => setAddingScript(true)}
      />
      <GitGroup thread={props.thread} git={git} move={checkout.move} onClose={props.onClose} />
      <LineageSection threadId={props.thread.id} onClose={props.onClose} />
      <RunningGroup
        threadId={props.thread.id}
        workspaceId={props.thread.workspaceId}
        workspacePath={props.workspacePath}
        onClose={props.onClose}
      />
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
