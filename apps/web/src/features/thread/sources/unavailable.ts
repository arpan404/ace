// TODO(client-gaps): feat/client-protocol-gaps. What a real daemon can't do for a thread yet:
// scripts, editors, git and forge (workspace.request / forge commands). Every call rejects, so
// the header controls stay disabled and actions report that the daemon can't do them, instead
// of pretending.
import { UnavailableError } from "@/boot/fake-backend.ts";
import type { WorkspaceSource } from "./workspace-source.ts";

const no = (feature: string) => () => Promise.reject(new UnavailableError(feature));

export function unavailableWorkspaceSource(): WorkspaceSource {
  return {
    scripts: no("Project scripts"),
    runScript: no("Project scripts"),
    editors: no("Opening an editor"),
    openIn: no("Opening an editor"),
    git: no("Git"),
    gitAction: no("Git"),
    switchBranch: no("Git"),
    setMode: no("Git"),
  };
}
