import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ForgeBrowseProvider, ForgeSidebar } from "@/features/forge-pages/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/** Pull requests and Issues: a project's list in the sidebar, the open item beside it. */
export const Route = createFileRoute("/_forge")({
  component: () => (
    <ForgeBrowseProvider>
      <ViewFrame label="Pull requests" sidebar={<ForgeSidebar />} place="sidebar">
        <Outlet />
      </ViewFrame>
    </ForgeBrowseProvider>
  ),
});
