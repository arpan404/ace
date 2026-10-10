import { projectInitials } from "@ace/ui-core";
import { ProjectImage } from "@/components/project-image.tsx";

/** The daemon discovers a favicon in the selected folder; artwork is not user supplied. */
export function ProjectIconPreview(props: { name: string; icon?: string | null | undefined }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-secondary text-sm font-medium text-muted-foreground">
        <ProjectImage
          icon={props.icon}
          className="h-8 w-8 rounded-sm object-contain"
          fallback={<span aria-hidden>{projectInitials(props.name)}</span>}
        />
      </div>
      <div className="grid gap-1">
        <span className="text-sm font-medium">Project icon</span>
        <span className="text-xs text-subtle-foreground">
          Detected from the folder's favicon. Uses initials when no favicon is found.
        </span>
      </div>
    </div>
  );
}
