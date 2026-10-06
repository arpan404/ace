import { createFileRoute, Outlet } from "@tanstack/react-router";
import { InstallDialogProvider, SkillsSidebar } from "@/features/skills/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/skills")({
  component: () => (
    <InstallDialogProvider>
      <ViewFrame label="Skills" sidebar={<SkillsSidebar />}>
        <Outlet />
      </ViewFrame>
    </InstallDialogProvider>
  ),
});
