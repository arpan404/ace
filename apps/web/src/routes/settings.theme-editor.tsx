import { createFileRoute } from "@tanstack/react-router";
import { SwatchesIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

/**
 * TODO(settings slice): token editor over src/theme (tokenGroups, contrastWarnings,
 * forkTheme, parseThemeFile, themeToFile, useTheme().saveTheme / deleteTheme).
 */
export const Route = createFileRoute("/settings/theme-editor")({
  component: () => (
    <SettingsBody
      page="Theme editor"
      lede="Edit the live theme. Presets are read-only: the first change forks a copy you own. Accent is set under Appearance and never changes status colours."
    >
      <EmptyState icon={SwatchesIcon} title="No custom themes yet" className="h-auto" />
    </SettingsBody>
  ),
});
