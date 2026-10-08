import { PermissionDefaults } from "@/components/permission-defaults.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
export function ProjectPermissionsDialog(props: {
  projectId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const project = useProjectDirectory().projects.find((row) => row.id === props.projectId);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permissions for {project?.name ?? "this project"}</DialogTitle>
          <DialogDescription>
            Defaults for new threads in this project. Each provider follows its global default until
            you choose an override.
          </DialogDescription>
        </DialogHeader>
        <PermissionDefaults workspaceId={props.projectId} />
      </DialogContent>
    </Dialog>
  );
}
