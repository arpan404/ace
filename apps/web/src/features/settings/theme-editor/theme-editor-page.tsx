import { CaretLeftIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { SettingsBody } from "../settings-body.tsx";
import { ThemeEditor } from "./theme-editor.tsx";

/** Settings › Appearance › Theme editor. Export lives in the editor's toolbar. */
export function ThemeEditorPage() {
  return (
    <SettingsBody
      page="Theme editor"
      back={
        <Link
          to="/settings/appearance"
          className={buttonVariants({
            size: "sm",
            variant: "ghost",
            className: "-mt-2 mb-2.5 -ml-2",
          })}
        >
          <CaretLeftIcon aria-hidden size={14} />
          Appearance
        </Link>
      }
    >
      <ThemeEditor />
    </SettingsBody>
  );
}
