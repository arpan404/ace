import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { fileTab, useScriptConfigurations } from "@/features/panels/index.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";

/** Existing configurations open for editing; new scripts use the Files create flow. */
export function ScriptConfigurationItems(props: {
  thread: ThreadRef;
  onClose(): void;
  onAddScript(): void;
}) {
  const query = useScriptConfigurations(props.thread.id);
  const workspace = useWorkspaceActions(props.thread.id);
  return (
    <>
      {query.isError ? (
        <MenuItem onClick={() => void query.refetch()}>
          Couldn't read script files. Try again
        </MenuItem>
      ) : query.isPending ? (
        <MenuItem disabled>Reading script files…</MenuItem>
      ) : (
        query.data?.map((path) => (
          <MenuItem
            key={path}
            onClick={() => {
              workspace.open(fileTab(path));
              props.onClose();
            }}
          >
            {path === "package.json" ? "Edit package.json scripts" : `Edit ${path}`}
          </MenuItem>
        ))
      )}
      <MenuSeparator />
      <MenuItem onClick={props.onAddScript}>New script file…</MenuItem>
    </>
  );
}
