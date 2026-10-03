import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SkillsSidebar } from "@/features/skills/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/skills")({
  component: () => (
    <ViewFrame label="Skills" sidebar={<SkillsSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
