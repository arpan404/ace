import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  InstallDialogProvider,
  SkillsSidebar,
  SkillsLibraryProvider,
} from "@/features/skills/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/skills")({
  component: () => (
    <SkillsLibraryProvider>
      <InstallDialogProvider>
        <ViewFrame label="Skills" sidebar={<SkillsSidebar />} place="sidebar">
          <Outlet />
        </ViewFrame>
      </InstallDialogProvider>
    </SkillsLibraryProvider>
  ),
});
