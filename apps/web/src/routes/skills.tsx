import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SkillsSidebar } from "@/features/skills/skills-sidebar.tsx";
import { ViewFrame } from "@/features/shell/view-frame.tsx";

export const Route = createFileRoute("/skills")({
  component: () => (
    <ViewFrame label="Skills" sidebar={<SkillsSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
