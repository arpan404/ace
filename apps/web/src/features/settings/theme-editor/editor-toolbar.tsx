import { useRef, useState } from "react";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { parseThemeFile, themeFromFile } from "@/theme/custom-themes.ts";
import { basePreset, presetTheme } from "@/theme/presets.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { baseOf, customThemeId, duplicateTheme, resetTheme } from "./editor-model.ts";
import { RenameTheme } from "./rename-theme.tsx";
import { newSuffix } from "./suffix.ts";
import { useExportTheme } from "./use-export-theme.ts";

/** Theme picker and the actions on the theme being edited. */
export function EditorToolbar() {
  const { theme, themes, update, saveTheme, deleteTheme } = useTheme();
  const toast = useToast();
  const exportTheme = useExportTheme();
  const fileInput = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const options = themes.map((candidate) => ({
    value: candidate.id,
    label: candidate.preset ? candidate.name : `${candidate.name} (custom)`,
  }));

  const duplicate = () => {
    const copy = duplicateTheme(theme, newSuffix());
    saveTheme(copy);
    update({ theme: copy.id });
    toast.add({ title: `Duplicated as ${copy.name}` });
  };
  const remove = () => {
    const removed = theme;
    deleteTheme(removed.id);
    update({ theme: baseOf(removed).id });
    toast.add({
      title: `Deleted ${removed.name}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          saveTheme(removed);
          update({ theme: removed.id });
        },
      },
    });
  };
  const importFile = async (file: File) => {
    try {
      const parsed = parseThemeFile(await file.text());
      const lineage = presetTheme(parsed.id?.split("~")[0] ?? "") ?? basePreset(parsed.scheme);
      const imported = themeFromFile(parsed, customThemeId(lineage, newSuffix()));
      saveTheme(imported);
      update({ theme: imported.id });
      toast.add({ title: `Imported ${imported.name}` });
    } catch (error) {
      toast.error({
        title: "Couldn't import that theme",
        description: error instanceof Error ? error.message : "The file couldn't be read.",
      });
    }
  };

  return (
    <div className="group/setting mt-4.5 flex flex-wrap items-center gap-2">
      <Select
        label="Theme to edit"
        value={theme.id}
        options={options}
        onValueChange={(id) => update({ theme: id })}
        className="min-w-[200px]"
      />
      <RowMenu label="Theme actions">
        <MenuItem onClick={duplicate}>Duplicate</MenuItem>
        <MenuItem onClick={() => fileInput.current?.click()}>Import</MenuItem>
        <MenuItem onClick={() => void exportTheme(theme)}>Export</MenuItem>
        {!theme.preset && (
          <>
            <MenuItem onClick={() => saveTheme(resetTheme(theme))}>
              Reset to {baseOf(theme).name}
            </MenuItem>
            <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
            <MenuItem danger onClick={remove}>
              Delete
            </MenuItem>
          </>
        )}
      </RowMenu>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        aria-label="Import theme file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      {!theme.preset && (
        <RenameTheme
          open={renaming}
          name={theme.name}
          onOpenChange={setRenaming}
          onRename={(name) => saveTheme({ ...theme, name })}
        />
      )}
    </div>
  );
}
