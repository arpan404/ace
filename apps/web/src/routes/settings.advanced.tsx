import { createFileRoute, Link } from "@tanstack/react-router";
import { SwatchesIcon } from "@phosphor-icons/react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

/** TODO(settings slice): unresponsive threshold, log retention, reset. */
export const Route = createFileRoute("/settings/advanced")({
  component: () => (
    <SettingsBody page="Advanced">
      <SettingSection label="Appearance">
        <SettingRow
          title="Theme editor"
          description="Every colour, glass and shape token, with import, export and contrast checks. Saved themes appear under Appearance."
        >
          <Link to="/settings/theme-editor" className={buttonVariants({ size: "sm" })}>
            <SwatchesIcon aria-hidden size={14} />
            Open theme editor
          </Link>
        </SettingRow>
      </SettingSection>
    </SettingsBody>
  ),
});
