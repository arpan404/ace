import { FolderPlusIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useProjectDialogs } from "./projects-host.tsx";

/** "Add project…" at the end of a project menu or picker. */
export function AddProjectItem() {
  const projects = useProjectDialogs();
  return (
    <MenuItem
      icon={<Icon icon={FolderPlusIcon} className="text-muted-foreground" />}
      keys={keymap.addProject.keys}
      onClick={() => projects.open({ kind: "add", tab: "open" })}
      onPointerEnter={projects.preload}
    >
      Add project…
    </MenuItem>
  );
}

/** Rename and Remove for one project, in its menu. */
export function ManageProjectItems(props: { projectId: string; name: string }) {
  const projects = useProjectDialogs();
  return (
    <>
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
