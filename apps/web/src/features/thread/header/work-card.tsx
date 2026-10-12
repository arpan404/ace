import { useThreadMeta } from "@ace/client-react";
import { lazy, Suspense, useState } from "react";
import { fileTab, loadCreateFile } from "@/features/panels/index.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { EnvironmentGroup } from "./work-card-environment.tsx";
import { GitGroup } from "./work-card-git.tsx";
import { RunningGroup } from "./work-card-running.tsx";

const CreateFile = lazy(() => loadCreateFile().then((module) => ({ default: module.CreateFile })));

/**
 * The Work card's groups: Environment, Git and Running. Its forms (commit, PR, a guarded
 * checkout move, a new script file) outlive the card, which closes when one opens.
 */
export function WorkCard(props: { threadId: string; onClose(): void }) {
  const meta = useThreadMeta(props.threadId);
  if (!meta)
    return (
      <p role="status" className="px-3 py-2 text-ui text-muted-foreground">
        Reading work…
      </p>
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
