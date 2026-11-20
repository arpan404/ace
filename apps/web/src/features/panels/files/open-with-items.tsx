import { EditorIcon } from "@/components/editor-icon.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useOpenInEditor } from "@/lib/open-in-editor.ts";

/**
 * The tree's Open with list for one checkout file: the apps on the daemon's machine that can
 * open it. This is the one place the tree asks for that list, so the Open in app list (editors
 * today) grows here for every row at once.
 */
export function OpenWithItems(props: { threadId: string; path: string }) {
  const { editors, editor, unavailable, open } = useOpenInEditor(props.threadId);
  if (!editors?.length)
    return <MenuItem disabled>{unavailable ?? "No editors installed"}</MenuItem>;
  return (
    <>
      {editors.map((each) => (
        <MenuItem
          key={each.id}
          icon={<EditorIcon id={each.id} />}
          onClick={() => void open(props.path, undefined, each.id)}
        >
          {each.name}
          {each.id === editor?.id && (
            <span className="ml-3 text-xs text-subtle-foreground">default</span>
          )}
        </MenuItem>
      ))}
    </>
  );
}
