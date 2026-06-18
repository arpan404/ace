import { createFileRoute } from "@tanstack/react-router";
import { FolderPlusIcon } from "lucide-react";
import { useEffect } from "react";

import { AppPageTopBar } from "../components/AppPageTopBar";
import { SidebarInset } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSetting } from "../hooks/useSettings";
import { requestSidebarAddProject } from "../lib/sidebarAddProjectRequest";

const EMPTY_PROJECT_TITLE = "No projects yet";
const EMPTY_PROJECT_DESCRIPTION = "Add a project to start a thread.";

function ChatIndexRouteView() {
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const defaultThreadEnvMode = useSetting("defaultThreadEnvMode");

  useEffect(() => {
    if (defaultProjectId === null) {
      return;
    }
    void handleNewThread(defaultProjectId, {
      envMode: defaultThreadEnvMode,
      replace: true,
    });
  }, [defaultProjectId, defaultThreadEnvMode, handleNewThread]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <div className="relative flex shrink-0 items-stretch overflow-hidden bg-background">
          <AppPageTopBar className="min-w-0 flex-1">
            <div className="min-w-0 flex-1" />
          </AppPageTopBar>
        </div>
        {defaultProjectId === null ? (
          <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-6 py-10">
            <section className="flex w-full max-w-sm flex-col items-center text-center">
              <button
                type="button"
                className="mb-4 inline-flex size-10 items-center justify-center rounded-[var(--control-radius)] border border-border/45 bg-foreground/[0.035] text-muted-foreground transition-colors hover:border-border/70 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label="Add project"
                onClick={requestSidebarAddProject}
              >
                <FolderPlusIcon className="size-5" strokeWidth={1.8} />
              </button>
              <h1 className="max-w-full truncate text-[24px] leading-8 font-medium text-foreground/92">
                {EMPTY_PROJECT_TITLE}
              </h1>
              <p className="mt-2 max-w-xs text-[13px] leading-5 text-muted-foreground/72">
                {EMPTY_PROJECT_DESCRIPTION}
              </p>
            </section>
          </main>
        ) : null}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
