import { EditorId, type ResolvedKeybindingsConfig } from "@ace/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { FolderClosedIcon } from "lucide-react";
import { MenuItem, MenuSeparator, MenuShortcut } from "../ui/menu";
import { AntigravityIcon, CursorIcon, Icon, TraeIcon, VisualStudioCode, Zed } from "../Icons";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
    },
    {
      label: "Trae",
      Icon: TraeIcon,
      value: "trae",
    },
    {
      label: "VS Code",
      Icon: VisualStudioCode,
      value: "vscode",
    },
    {
      label: "VS Code Insiders",
      Icon: VisualStudioCode,
      value: "vscode-insiders",
    },
    {
      label: "VSCodium",
      Icon: VisualStudioCode,
      value: "vscodium",
    },
    {
      label: "Zed",
      Icon: Zed,
      value: "zed",
    },
    {
      label: "Antigravity",
      Icon: AntigravityIcon,
      value: "antigravity",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ];
  return baseOptions.filter((option) => availableEditors.includes(option.value));
};

/** Open-in-editor rows for use inside another menu (e.g. workspace editor toolbar). */
export const OpenInEditorMenuSection = memo(function OpenInEditorMenuSection({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      setPreferredEditor(editor);
    },
    [preferredEditor, openInCwd, setPreferredEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void api.shell.openInEditor(openInCwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, keybindings, openInCwd]);

  if (!openInCwd) {
    return null;
  }

  return (
    <>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Open in editor</div>
      {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
      {options.map(({ label, Icon, value }) => (
        <MenuItem key={value} onClick={() => openInEditor(value)}>
          <Icon aria-hidden="true" className="text-muted-foreground" />
          {label}
          {value === preferredEditor && openFavoriteEditorShortcutLabel ? (
            <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
          ) : null}
        </MenuItem>
      ))}
      <MenuSeparator />
    </>
  );
});
