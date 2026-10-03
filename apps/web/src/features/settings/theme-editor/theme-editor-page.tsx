import { CaretLeftIcon, ExportIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { SettingsBody } from "../settings-body.tsx";
import { ThemeEditor } from "./theme-editor.tsx";
import { useExportTheme } from "./use-export-theme.ts";

/** Settings › Advanced › Theme editor. */
export function ThemeEditorPage() {
  const { theme } = useTheme();
  const exportTheme = useExportTheme();
  return (
    <SettingsBody
      page="Theme editor"
      lede="Edit the live theme. Presets are read-only: the first change forks a copy you own. Accent is set under Appearance and never changes status colours."
      back={
        <Link
          to="/settings/advanced"
          className={buttonVariants({
            size: "sm",
            variant: "ghost",
            className: "-mt-2 mb-2.5 -ml-2",
          })}
        >
          <CaretLeftIcon aria-hidden size={14} />
          Advanced
        </Link>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => void exportTheme(theme)}>
          <ExportIcon aria-hidden size={14} />
          Export
        </Button>
      }
    >
      <ThemeEditor />
    </SettingsBody>
  );
}
