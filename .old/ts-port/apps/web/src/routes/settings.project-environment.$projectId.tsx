import { ProjectId } from "@ace/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectEnvironmentSettingsPanelRoute } from "../components/settings/LazySettingsPanels";

function ProjectEnvironmentSettingsRoute() {
  const projectId = Route.useParams({
    select: (params) => ProjectId.makeUnsafe(params.projectId),
  });

  return <ProjectEnvironmentSettingsPanelRoute projectId={projectId} />;
}

export const Route = createFileRoute("/settings/project-environment/$projectId")({
  component: ProjectEnvironmentSettingsRoute,
});
