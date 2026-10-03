import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MoreSidebar } from "@/features/more/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/more")({
  component: () => (
    <ViewFrame label="More" sidebar={<MoreSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
