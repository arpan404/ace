import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  InstallDialogProvider,
  SkillsSidebar,
  SkillsCatalogProvider,
} from "@/features/skills/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/skills")({
  component: () => (
    <SkillsCatalogProvider>
      <InstallDialogProvider>
        <ViewFrame label="Skills" sidebar={<SkillsSidebar />} place="sidebar">
          <Outlet />
        </ViewFrame>
      </InstallDialogProvider>
    </SkillsCatalogProvider>
  ),
});
