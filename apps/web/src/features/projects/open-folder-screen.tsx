import { FolderSimpleIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { displayPath, folderName } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useLandInProject } from "./land.ts";
import { projectFailure, useProjectCommands } from "./project-commands.ts";
import { useProjectDialogs } from "./projects-host.tsx";

/**
 * `/new?folder=<path>` (the desktop's `ace://open?folder=`, Open in ace, a folder dropped on
 * the dock): add the folder as a project, or find it if it is one, and open New thread in it.
 * Waits for the daemon; a folder it refuses says why and offers Add project.
 */
export function OpenFolderScreen(props: { folder: string }) {
  const ready = useConnectionState() === "ready";
  const commands = useProjectCommands();
  const land = useLandInProject();
  const projects = useProjectDialogs();
  const [failure, setFailure] = useState<ReturnType<typeof projectFailure>>();

  useEffect(() => {
    if (!ready) return;
    let current = true;
    commands.add(props.folder).then(
      (result) => {
        if (current) land(result, "Opened", { replace: true });
      },
      (error: unknown) => {
        if (current) setFailure(projectFailure(error));
      },
    );
    return () => {
      current = false;
    };
  }, [ready, commands, land, props.folder]);

  const name = folderName(props.folder);
  return (
    <Screen title="New thread" subtitle={name}>
      {failure ? (
        <EmptyState
          icon={failure.denied ? LockSimpleIcon : FolderSimpleIcon}
          title={`Couldn't open ${name}`}
          description={failure.message}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="primary"
                onClick={() =>
                  projects.open({
                    kind: "add",
                    tab: "open",
                    attempt: { path: props.folder, problem: failure.message },
                  })
                }
              >
                Choose another folder…
              </Button>
              <Link to="/new" replace className={buttonVariants()}>
                New thread
              </Link>
            </div>
          }
        />
      ) : (
        <div
          role="status"
          className="flex h-full items-center justify-center gap-2 text-ui text-muted-foreground"
        >
          <Spinner />
          {ready ? `Opening ${displayPath(props.folder, undefined)}…` : "Waiting for the daemon…"}
        </div>
      )}
    </Screen>
  );
}
