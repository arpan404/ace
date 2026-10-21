import {
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  CheckSquareIcon,
  CopyIcon,
  DotsThreeIcon,
  SquareIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { EditorIcon } from "@/components/editor-icon.tsx";
import { useOpenInEditor } from "@/lib/open-in-editor.ts";

/**
 * The end of a file's header: Viewed (folds the file and remembers this version of its diff as
 * read; a later edit to the file clears it) and the file's menu: open it in the editor, copy its
 * path, fold it.
 */
export function FileActions(props: {
  threadId: string;
  path: string;
  /** Absent where a scope has no review (uncommitted changes): no Viewed toggle. */
  viewed?: boolean | undefined;
  open: boolean;
  onViewed?: ((viewed: boolean) => void) | undefined;
  onOpen(open: boolean): void;
}) {
  const toast = useToast();
  const copy = () => {
    void navigator.clipboard
      ?.writeText(props.path)
      .catch(() => toast.error({ title: "Couldn't copy the path" }));
  };
  return (
    <>
      {props.onViewed && <ViewedToggle viewed={props.viewed ?? false} onViewed={props.onViewed} />}
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              icon={DotsThreeIcon}
              label={`Actions for ${props.path}`}
              size="sm"
              tooltip={false}
            />
          }
        />
        <MenuContent align="end">
          <OpenInEditorItem threadId={props.threadId} path={props.path} />
          <MenuItem icon={<CopyIcon aria-hidden size={16} />} onClick={copy}>
            Copy path
          </MenuItem>
          <MenuItem
            icon={
              props.open ? (
                <ArrowsInLineVerticalIcon aria-hidden size={16} />
              ) : (
                <ArrowsOutLineVerticalIcon aria-hidden size={16} />
              )
            }
            onClick={() => props.onOpen(!props.open)}
          >
            {props.open ? "Collapse file" : "Expand file"}
          </MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
}

function ViewedToggle(props: { viewed: boolean; onViewed(viewed: boolean): void }) {
  return (
    <button
      type="button"
      aria-pressed={props.viewed}
      onClick={() => props.onViewed(!props.viewed)}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground outline-none transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground focus-ring",
        props.viewed && "text-foreground",
      )}
    >
      <Icon icon={props.viewed ? CheckSquareIcon : SquareIcon} size={14} active={props.viewed} />
      Viewed
    </button>
  );
}

/** The file in the device's editor on the checkout's machine; absent with no editor installed. */
function OpenInEditorItem(props: { threadId: string; path: string }) {
  const editing = useOpenInEditor(props.threadId);
  const editor = editing.editor;
  if (!editor) return null;
  return (
    <MenuItem icon={<EditorIcon id={editor.id} />} onClick={() => void editing.open(props.path)}>
      Open in {editor.name}
    </MenuItem>
  );
}
