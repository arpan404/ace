import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { useThreadMeta } from "@ace/client-react";
import { useState, lazy, Suspense } from "react";
import { fileTab, loadCreateFile } from "@/features/panels/index.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useCheckoutMove } from "./checkout-move.tsx";
import { useGitFlow } from "./use-git-flow.tsx";
import { ProjectRow } from "./work-card-environment.tsx";
import { BranchRow, ChangesSection, GitMenuItems } from "./work-card-git.tsx";
import { PullRequestsSection } from "./work-card-pr.tsx";
import { WorkStateProvider } from "./work-state.tsx";

const keepWorkOpen = () => {};

const CreateFile = lazy(() => loadCreateFile().then((module) => ({ default: module.CreateFile })));

/** Environment and git controls used by the right-panel Work tab. */
export function WorkEnvironment(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  return meta ? (
    <EnvironmentActions
      thread={{
        id: props.threadId,
        workspaceId: meta.workspaceId,
        title: meta.title,
        provider: meta.provider,
      }}
    />
  ) : null;
}

function EnvironmentActions(props: { thread: ThreadRef }) {
  const git = useGitFlow(props.thread);
  const [linking, setLinking] = useState(false);
  const [addingScript, setAddingScript] = useState(false);
  const workspace = useWorkspaceActions(props.thread.id);
  const checkout = useCheckoutMove(props.thread);
  return (
    <WorkStateProvider scope={props.thread.id}>
      <div className="divide-y divide-border [&>section]:px-3">
        <ProjectRow
          thread={props.thread}
          move={checkout.move}
          onClose={keepWorkOpen}
          onAddScript={() => {
            setAddingScript(true);
          }}
          menuFocus={() =>
            linking
              ? (document.querySelector<HTMLInputElement>('[aria-label="Link pull request…"]') ??
                false)
              : !git.dialog
          }
          actions={
            <>
              {git.checkout && (
                <>
                  <MenuSeparator />
                  <GitMenuItems git={git} checkout={git.checkout} />
                </>
              )}
              {git.checkout?.repository?.forge !== "gitlab" && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    disabled={!!git.linkBlocked || git.pending}
                    reason={git.linkBlocked}
                    onClick={() => setLinking(true)}
                  >
                    Link a pull request
                  </MenuItem>
                </>
              )}
            </>
          }
        />
        <section aria-label="Source control" className="py-3">
          <BranchRow thread={props.thread} git={git} move={checkout.move} />
          <PullRequestsSection
            git={git}
            workspaceId={props.thread.workspaceId}
            linking={linking}
            onLinkClose={() => setLinking(false)}
          />
          <ChangesSection thread={props.thread} git={git} onClose={keepWorkOpen} />
        </section>
      </div>
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
    </WorkStateProvider>
  );
}
