import {
  FolderPlusIcon,
  ArrowSquareOutIcon,
  PencilSimpleIcon,
  TrashIcon,
  ShieldIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import {
  MenuItem,
  MenuSub,
  MenuSubTrigger,
  MenuContent,
  MenuSeparator,
} from "@/components/ui/menu.tsx";
import { useConnectionState } from "@ace/client-react";
import { useProjectDialogs } from "./projects-host.tsx";

const DeferredOpenIn = deferredComponent(() =>
  import("./project-open-in.tsx").then((module) => module.ProjectOpenIn),
);

/** "Add project…" at the end of a project menu or picker. */
export function AddProjectItem() {
  const projects = useProjectDialogs();
  const reachable = useConnectionState() === "ready";
  return (
    <MenuItem
      icon={<Icon icon={FolderPlusIcon} className="text-muted-foreground" />}
      shortcut="addProject"
      disabled={!reachable}
      reason={reachable ? undefined : "Connect to this computer to add a project."}
      onClick={() => projects.open({ kind: "add", tab: "open" })}
      onPointerEnter={projects.preload}
    >
      Add project…
    </MenuItem>
  );
}

/** Editor handoff, Rename and Remove for one project, in its menu. */
export function ManageProjectItems(props: { projectId: string; name: string }) {
  const projects = useProjectDialogs();
  return (
    <>
      <MenuSub>
        <MenuSubTrigger icon={<Icon icon={ArrowSquareOutIcon} />}>Open in…</MenuSubTrigger>
        <MenuContent>
          <Suspense fallback={<MenuItem disabled>Looking for editors…</MenuItem>}>
            <DeferredOpenIn.Component projectId={props.projectId} />
          </Suspense>
        </MenuContent>
      </MenuSub>
      <MenuSeparator />
      <MenuItem
        icon={<Icon icon={ShieldIcon} />}
        onClick={() => projects.open({ kind: "permissions", projectId: props.projectId })}
        onPointerEnter={projects.preload}
      >
        Project permissions…
      </MenuItem>
      <MenuItem
        icon={<Icon icon={PencilSimpleIcon} className="text-muted-foreground" />}
        onClick={() => projects.open({ kind: "rename", projectId: props.projectId })}
        onPointerEnter={projects.preload}
      >
        Rename {props.name}…
      </MenuItem>
      <MenuItem
        icon={<Icon icon={TrashIcon} />}
        danger
        onClick={() => projects.open({ kind: "remove", projectId: props.projectId })}
        onPointerEnter={projects.preload}
      >
        Remove {props.name}…
      </MenuItem>
    </>
  );
}
