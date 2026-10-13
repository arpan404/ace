import { projectIconMatches } from "@ace/project-picker";
import { ProjectError } from "./project-policy.ts";

/** Refuse a project image whose bytes aren't the image type it claims (`project_icon_invalid`). */
export function assertProjectImage(icon: string | null | undefined): void {
  if (typeof icon === "string" && !projectIconMatches(icon))
    throw new ProjectError("project_icon_invalid");
}
