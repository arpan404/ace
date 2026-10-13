import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  InstallDialogProvider,
  SkillsSidebar,
  SkillsCatalogProvider,
} from "@/features/skills/index.ts";
import { SettingsNav } from "@/features/settings/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/** Skills is a section of Settings' sidebar: its catalog sits under its link there. */
export const Route = createFileRoute("/skills")({
  component: () => (
    <SkillsCatalogProvider>
      <InstallDialogProvider>
        <ViewFrame
          label="Settings"
          sidebar={<SettingsNav section={{ to: "/skills", list: <SkillsSidebar /> }} />}
          place="sidebar"
        >
          <Outlet />
        </ViewFrame>
      </InstallDialogProvider>
    </SkillsCatalogProvider>
  ),
});
